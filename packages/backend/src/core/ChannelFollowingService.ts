import { Inject, Injectable, OnModuleInit, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { LocalUser, PartialLocalUser, PartialRemoteUser, RemoteUser, User } from '@/models/entities/User.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { QueueService } from '@/core/QueueService.js';
import PerUserFollowingChart from '@/core/chart/charts/per-user-following.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import type { Packed } from '@/misc/json-schema.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { WebhookService } from '@/core/WebhookService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { DI } from '@/di-symbols.js';
import type { ChannelFollowRequestsRepository, ChannelsRepository, FollowingsRepository, FollowRequestsRepository, InstancesRepository, UserProfilesRepository, UsersRepository } from '@/models/index.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { bindThis } from '@/decorators.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { MetaService } from '@/core/MetaService.js';
import { CacheService } from '@/core/CacheService.js';
import type { Config } from '@/config.js';
import Logger from '../logger.js';
import { IsNull } from 'typeorm';
import { AccountMoveService } from '@/core/AccountMoveService.js';
import { ChannelEntity } from '@/models/entities/Channel.js';

const logger = new Logger('following/create');

type Local = LocalUser | {
	id: LocalUser['id'];
	host: LocalUser['host'];
	uri: LocalUser['uri']
};
type Channel = ChannelEntity;

@Injectable()
export class UserFollowingService implements OnModuleInit {
	private userBlockingService: UserBlockingService;

	constructor(
		private moduleRef: ModuleRef,

		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.channelFollowRequestsRepository)
		private channelFollowRequestsRepository: ChannelFollowRequestsRepository,

		@Inject(DI.channelsRepository)
		private channelRepository: ChannelsRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private cacheService: CacheService,
		private userEntityService: UserEntityService,
		private idService: IdService,
		private queueService: QueueService,
		private globalEventService: GlobalEventService,
		private metaService: MetaService,
		private notificationService: NotificationService,
		private federatedInstanceService: FederatedInstanceService,
		private webhookService: WebhookService,
		private apRendererService: ApRendererService,
		private accountMoveService: AccountMoveService,
		private perUserFollowingChart: PerUserFollowingChart,
		private instanceChart: InstanceChart,
	) {
	}

	onModuleInit() {
		this.userBlockingService = this.moduleRef.get('UserBlockingService');
	}

	@bindThis
	public async follow(_follower: { id: User['id'] }, _channel: { id: Channel['id'] }, requestId?: string, silent = false): Promise<void> {
		const [follower, channel] = await Promise.all([
			this.usersRepository.findOneByOrFail({ id: _follower.id }),
			this.channelRepository.findOneByOrFail({ id: _channel.id }),
		]) as [LocalUser | RemoteUser, Channel];

		// check blocking
		const [blocking, blocked] = await Promise.all([
			this.userBlockingService.checkBlocked(follower.id, channel.id),
			this.userBlockingService.checkBlocked(channel.id, follower.id),
		]);

		if (this.userEntityService.isRemoteUser(follower) && blocked) {
			// リモートフォローを受けてブロックしていた場合は、エラーにするのではなくRejectを送り返しておしまい。
			const content = this.apRendererService.addContext(this.apRendererService.renderReject(this.apRendererService.renderFollow(follower, followee, requestId), followee));
			this.queueService.deliver(channel, content, follower.inbox, false);
			return;
		} else if (this.userEntityService.isRemoteUser(follower) && blocking) {
			// リモートフォローを受けてブロックされているはずの場合だったら、ブロック解除しておく。
			await this.userBlockingService.unblock(follower, channel);
		} else {
			// それ以外は単純に例外
			if (blocking) throw new IdentifiableError('710e8fb0-b8c3-4922-be49-d5d93d8e6a6e', 'blocking');
			if (blocked) throw new IdentifiableError('3338392a-f764-498d-8855-db939dcf8c48', 'blocked');
		}

		const followeeProfile = await this.userProfilesRepository.findOneByOrFail({ userId: followee.id });

		// フォロー対象が鍵アカウントである or
		// フォロワーがBotであり、フォロー対象がBotからのフォローに慎重である or
		// フォロワーがローカルユーザーであり、フォロー対象がリモートユーザーである
		// 上記のいずれかに当てはまる場合はすぐフォローせずにフォローリクエストを発行しておく
		if (followee.isLocked || (followeeProfile.carefulBot && follower.isBot) || (this.userEntityService.isLocalUser(follower) && this.userEntityService.isRemoteUser(followee))) {
			let autoAccept = false;

			// 鍵アカウントであっても、既にフォローされていた場合はスルー
			const following = await this.followingsRepository.findOneBy({
				followerId: follower.id,
				followeeId: followee.id,
			});
			if (following) {
				autoAccept = true;
			}

			// フォローしているユーザーは自動承認オプション
			if (!autoAccept && (this.userEntityService.isLocalUser(followee) && followeeProfile.autoAcceptFollowed)) {
				const followed = await this.followingsRepository.findOneBy({
					followerId: followee.id,
					followeeId: follower.id,
				});

				if (followed) autoAccept = true;
			}

			// Automatically accept if the follower is an account who has moved and the locked followee had accepted the old account.
			if (followee.isLocked && !autoAccept) {
				autoAccept = !!(await this.accountMoveService.validateAlsoKnownAs(
					follower,
					(oldSrc, newSrc) => this.followingsRepository.exist({
						where: {
							followeeId: followee.id,
							followerId: newSrc.id,
						},
					}),
					true,
				));
			}

			if (!autoAccept) {
				await this.createFollowRequest(follower, followee, requestId);
				return;
			}
		}

		await this.insertFollowingDoc(followee, follower, silent);

		if (this.userEntityService.isRemoteUser(follower) && this.userEntityService.isLocalUser(followee)) {
			const content = this.apRendererService.addContext(this.apRendererService.renderAccept(this.apRendererService.renderFollow(follower, followee, requestId), followee));
			this.queueService.deliver(followee, content, follower.inbox, false);
		}
	}

	@bindThis
	private async insertFollowingDoc(
		channel: Channel,
		follower: {
			id: User['id']; host: User['host']; uri: User['host']; inbox: User['inbox']; sharedInbox: User['sharedInbox']
		},
		silent = false,
	): Promise<void> {
		if (follower.id === channel.user!.id) return;

		let alreadyFollowed = false as boolean;

		await this.channelFollowRequestsRepository.insert({
			id: this.idService.genId(),
			createdAt: new Date(),
			followerId: follower.id,
			channelId: channel.id,
		}).catch(err => {
			if (isDuplicateKeyValueError(err) && this.userEntityService.isRemoteUser(follower)) {
				logger.info(`Insert duplicated ignore. ${follower.id} => ${channel.id}`);
				alreadyFollowed = true;
			} else {
				throw err;
			}
		});

		const req = await this.channelFollowRequestsRepository.findOneBy({
			channelId: channel.id,
			followerId: follower.id,
		});

		if (req) {
			await this.channelFollowRequestsRepository.delete({
				channelId: channel.id,
				followerId: follower.id,
			});

			// TODO:通知を作成
			// this.notificationService.createNotification(follower.id, 'followRequestAccepted', {
			// 	notifierId: channel.id,
			// });
		}

		if (alreadyFollowed) return;

		this.globalEventService.publishInternalEvent('follow', { followerId: follower.id, followeeId: followee.id });

		const [followeeUser, followerUser] = await Promise.all([
			this.usersRepository.findOneByOrFail({ id: followee.id }),
			this.usersRepository.findOneByOrFail({ id: follower.id }),
		]);

		// // TODO: Publish follow event
		// if (this.userEntityService.isLocalUser(follower) && !silent) {
		// 	this.userEntityService.pack(followee.id, follower, {
		// 		detail: true,
		// 	}).then(async packed => {
		// 		this.globalEventService.publishMainStream(follower.id, 'follow', packed as Packed<'UserDetailedNotMe'>);

		// 		const webhooks = (await this.webhookService.getActiveWebhooks()).filter(x => x.userId === follower.id && x.on.includes('follow'));
		// 		for (const webhook of webhooks) {
		// 			this.queueService.webhookDeliver(webhook, 'follow', {
		// 				user: packed,
		// 			});
		// 		}
		// 	});
		// }

		// // Publish followed event
		// if (this.userEntityService.isLocalUser(followee)) {
		// 	this.userEntityService.pack(follower.id, followee).then(async packed => {
		// 		this.globalEventService.publishMainStream(followee.id, 'followed', packed);

		// 		const webhooks = (await this.webhookService.getActiveWebhooks()).filter(x => x.userId === followee.id && x.on.includes('followed'));
		// 		for (const webhook of webhooks) {
		// 			this.queueService.webhookDeliver(webhook, 'followed', {
		// 				user: packed,
		// 			});
		// 		}
		// 	});

		// 	// 通知を作成
		// 	this.notificationService.createNotification(followee.id, 'follow', {
		// 		notifierId: follower.id,
		// 	});
		// }
	}

	@bindThis
	public async unfollow(
		channel: Channel,
		followee: {
			id: User['id']; host: User['host']; uri: User['host']; inbox: User['inbox']; sharedInbox: User['sharedInbox'];
		},
		silent = false,
	): Promise<void> {
		const following = await this.channelFollowRequestsRepository.findOne({
			relations: {
				follower: true,
				channelId: true,
			},
			where: {
				followerId: channel.id,
				channelId: followee.id,
			}
		});

		if (following === null || !following.follower || !following.followee) {
			logger.warn('フォロー解除がリクエストされましたがフォローしていませんでした');
			return;
		}

		await this.followingsRepository.delete(following.id);

		this.cacheService.userFollowingsCache.refresh(follower.id);

		this.decrementFollowing(following.follower, following.followee);

		// Publish unfollow event
		if (!silent && this.userEntityService.isLocalUser(follower)) {
			this.userEntityService.pack(followee.id, follower, {
				detail: true,
			}).then(async packed => {
				this.globalEventService.publishMainStream(follower.id, 'unfollow', packed);

				const webhooks = (await this.webhookService.getActiveWebhooks()).filter(x => x.userId === follower.id && x.on.includes('unfollow'));
				for (const webhook of webhooks) {
					this.queueService.webhookDeliver(webhook, 'unfollow', {
						user: packed,
					});
				}
			});
		}

		if (this.userEntityService.isLocalUser(follower) && this.userEntityService.isRemoteUser(followee)) {
			const content = this.apRendererService.addContext(this.apRendererService.renderUndo(this.apRendererService.renderFollow(follower as PartialLocalUser, followee as PartialRemoteUser), follower));
			this.queueService.deliver(follower, content, followee.inbox, false);
		}

		if (this.userEntityService.isLocalUser(followee) && this.userEntityService.isRemoteUser(follower)) {
			// local user has null host
			const content = this.apRendererService.addContext(this.apRendererService.renderReject(this.apRendererService.renderFollow(follower as PartialRemoteUser, followee as PartialLocalUser), followee));
			this.queueService.deliver(followee, content, follower.inbox, false);
		}
	}

	@bindThis
	private async decrementFollowing(
		follower: User,
		followee: User,
	): Promise<void> {
		this.globalEventService.publishInternalEvent('unfollow', { followerId: follower.id, followeeId: followee.id });

		// Neither followee nor follower has moved.
		if (!follower.movedToUri && !followee.movedToUri) {
			//#region Decrement following / followers counts
			await Promise.all([
				this.usersRepository.decrement({ id: follower.id }, 'followingCount', 1),
				this.usersRepository.decrement({ id: followee.id }, 'followersCount', 1),
			]);
			//#endregion

			//#region Update instance stats
			if (this.userEntityService.isRemoteUser(follower) && this.userEntityService.isLocalUser(followee)) {
				this.federatedInstanceService.fetch(follower.host).then(async i => {
					this.instancesRepository.decrement({ id: i.id }, 'followingCount', 1);
					if ((await this.metaService.fetch()).enableChartsForFederatedInstances) {
						this.instanceChart.updateFollowing(i.host, false);
					}
				});
			} else if (this.userEntityService.isLocalUser(follower) && this.userEntityService.isRemoteUser(followee)) {
				this.federatedInstanceService.fetch(followee.host).then(async i => {
					this.instancesRepository.decrement({ id: i.id }, 'followersCount', 1);
					if ((await this.metaService.fetch()).enableChartsForFederatedInstances) {
						this.instanceChart.updateFollowers(i.host, false);
					}
				});
			}
			//#endregion

			this.perUserFollowingChart.update(follower, followee, false);
		} else {
			// Adjust following/followers counts
			for (const user of [follower, followee]) {
				if (user.movedToUri) continue; // No need to update if the user has already moved.

				const nonMovedFollowees = await this.followingsRepository.count({
					relations: {
						followee: true,
					},
					where: {
						followerId: user.id,
						followee: {
							movedToUri: IsNull(),
						}
					}
				});
				const nonMovedFollowers = await this.followingsRepository.count({
					relations: {
						follower: true,
					},
					where: {
						followeeId: user.id,
						follower: {
							movedToUri: IsNull(),
						}
					}
				});
				await this.usersRepository.update(
					{ id: user.id },
					{ followingCount: nonMovedFollowees, followersCount: nonMovedFollowers },
				);
			}

			// TODO: adjust charts
		}
	}

	@bindThis
	public async createFollowRequest(
		follower: {
			id: User['id']; host: User['host']; uri: User['host']; inbox: User['inbox']; sharedInbox: User['sharedInbox'];
		},
		followee: {
			id: User['id']; host: User['host']; uri: User['host']; inbox: User['inbox']; sharedInbox: User['sharedInbox'];
		},
		requestId?: string,
	): Promise<void> {
		if (follower.id === followee.id) return;

		// check blocking
		const [blocking, blocked] = await Promise.all([
			this.userBlockingService.checkBlocked(follower.id, followee.id),
			this.userBlockingService.checkBlocked(followee.id, follower.id),
		]);

		if (blocking) throw new Error('blocking');
		if (blocked) throw new Error('blocked');

		const followRequest = await this.followRequestsRepository.insert({
			id: this.idService.genId(),
			createdAt: new Date(),
			followerId: follower.id,
			followeeId: followee.id,
			requestId,

			// 非正規化
			followerHost: follower.host,
			followerInbox: this.userEntityService.isRemoteUser(follower) ? follower.inbox : undefined,
			followerSharedInbox: this.userEntityService.isRemoteUser(follower) ? follower.sharedInbox : undefined,
			followeeHost: followee.host,
			followeeInbox: this.userEntityService.isRemoteUser(followee) ? followee.inbox : undefined,
			followeeSharedInbox: this.userEntityService.isRemoteUser(followee) ? followee.sharedInbox : undefined,
		}).then(x => this.followRequestsRepository.findOneByOrFail(x.identifiers[0]));

		// Publish receiveRequest event
		if (this.userEntityService.isLocalUser(followee)) {
			this.userEntityService.pack(follower.id, followee).then(packed => this.globalEventService.publishMainStream(followee.id, 'receiveFollowRequest', packed));

			this.userEntityService.pack(followee.id, followee, {
				detail: true,
			}).then(packed => this.globalEventService.publishMainStream(followee.id, 'meUpdated', packed));

			// 通知を作成
			this.notificationService.createNotification(followee.id, 'receiveFollowRequest', {
				notifierId: follower.id,
				followRequestId: followRequest.id,
			});
		}

		if (this.userEntityService.isLocalUser(follower) && this.userEntityService.isRemoteUser(followee)) {
			const content = this.apRendererService.addContext(this.apRendererService.renderFollow(follower as PartialLocalUser, followee as PartialRemoteUser, requestId ?? `${this.config.url}/follows/${followRequest.id}`));
			this.queueService.deliver(follower, content, followee.inbox, false);
		}
	}

	@bindThis
	public async cancelFollowRequest(
		followee: {
			id: User['id']; host: User['host']; uri: User['host']; inbox: User['inbox']
		},
		follower: {
			id: User['id']; host: User['host']; uri: User['host']
		},
	): Promise<void> {
		if (this.userEntityService.isRemoteUser(followee)) {
			const content = this.apRendererService.addContext(this.apRendererService.renderUndo(this.apRendererService.renderFollow(follower as PartialLocalUser | PartialRemoteUser, followee as PartialRemoteUser), follower));

			if (this.userEntityService.isLocalUser(follower)) { // 本来このチェックは不要だけどTSに怒られるので
				this.queueService.deliver(follower, content, followee.inbox, false);
			}
		}

		const request = await this.followRequestsRepository.findOneBy({
			followeeId: followee.id,
			followerId: follower.id,
		});

		if (request == null) {
			throw new IdentifiableError('17447091-ce07-46dd-b331-c1fd4f15b1e7', 'request not found');
		}

		await this.followRequestsRepository.delete({
			followeeId: followee.id,
			followerId: follower.id,
		});

		this.userEntityService.pack(followee.id, followee, {
			detail: true,
		}).then(packed => this.globalEventService.publishMainStream(followee.id, 'meUpdated', packed));
	}

	@bindThis
	public async acceptFollowRequest(
		followee: {
			id: User['id']; host: User['host']; uri: User['host']; inbox: User['inbox']; sharedInbox: User['sharedInbox'];
		},
		follower: User,
	): Promise<void> {
		const request = await this.followRequestsRepository.findOneBy({
			followeeId: followee.id,
			followerId: follower.id,
		});

		if (request == null) {
			throw new IdentifiableError('8884c2dd-5795-4ac9-b27e-6a01d38190f9', 'No follow request.');
		}

		await this.insertFollowingDoc(followee, follower);

		if (this.userEntityService.isRemoteUser(follower) && this.userEntityService.isLocalUser(followee)) {
			const content = this.apRendererService.addContext(this.apRendererService.renderAccept(this.apRendererService.renderFollow(follower, followee as PartialLocalUser, request.requestId!), followee));
			this.queueService.deliver(followee, content, follower.inbox, false);
		}

		this.userEntityService.pack(followee.id, followee, {
			detail: true,
		}).then(packed => this.globalEventService.publishMainStream(followee.id, 'meUpdated', packed));
	}

	@bindThis
	public async acceptAllFollowRequests(
		user: {
			id: User['id']; host: User['host']; uri: User['host']; inbox: User['inbox']; sharedInbox: User['sharedInbox'];
		},
	): Promise<void> {
		const requests = await this.followRequestsRepository.findBy({
			followeeId: user.id,
		});

		for (const request of requests) {
			const follower = await this.usersRepository.findOneByOrFail({ id: request.followerId });
			this.acceptFollowRequest(user, follower);
		}
	}

	/**
	 * API following/request/reject
	 */
	@bindThis
	public async rejectFollowRequest(channel: Channel, follower: Local): Promise<void> {
		await this.removeFollowRequest(channel, follower);

		if (this.userEntityService.isLocalUser(follower)) {
			this.publishUnfollow(channel, follower);
		}
	}

	/**
	 * API following/reject
	 */
	@bindThis
	public async rejectFollow(channel: Channel, follower: Local): Promise<void> {
		await this.removeFollow(channel, follower);

		if (this.userEntityService.isLocalUser(follower)) {
			this.publishUnfollow(channel, follower);
		}
	}

	/**
	 * Remove follow request record
	 */
	@bindThis
	private async removeFollowRequest(channel: Channel, follower: Local): Promise<void> {
		const request = await this.followRequestsRepository.findOneBy({
			followeeId: channel.id,
			followerId: follower.id,
		});

		if (!request) return;

		await this.followRequestsRepository.delete(request.id);
	}

	/**
	 * Remove follow record
	 */
	@bindThis
	private async removeFollow(followee: Both, follower: Both): Promise<void> {
		const following = await this.followingsRepository.findOne({
			relations: {
				followee: true,
				follower: true,
			},
			where: {
				followeeId: followee.id,
				followerId: follower.id,
			}
		});

		if (!following || !following.followee || !following.follower) return;

		await this.followingsRepository.delete(following.id);

		this.decrementFollowing(following.follower, following.followee);
	}

	/**
	 * Deliver Reject to remote
	 */
	@bindThis
	private async deliverReject(followee: Local, follower: Remote): Promise<void> {
		const request = await this.followRequestsRepository.findOneBy({
			channelId: followee.id,
			followerId: follower.id,
		});

		const content = this.apRendererService.addContext(this.apRendererService.renderReject(this.apRendererService.renderFollow(follower, followee, request?.requestId ?? undefined), followee));
		this.queueService.deliver(followee, content, follower.inbox, false);
	}

	/**
	 * Publish unfollow to local
	 */
	@bindThis
	private async publishUnfollow(followee: Both, follower: Local): Promise<void> {
		const packedFollowee = await this.userEntityService.pack(followee.id, follower, {
			detail: true,
		});

		this.globalEventService.publishMainStream(follower.id, 'unfollow', packedFollowee);

		const webhooks = (await this.webhookService.getActiveWebhooks()).filter(x => x.userId === follower.id && x.on.includes('unfollow'));
		for (const webhook of webhooks) {
			this.queueService.webhookDeliver(webhook, 'unfollow', {
				user: packedFollowee,
			});
		}
	}
}
