import { Inject, Injectable } from '@nestjs/common';
import type { Channel, ChannelFollowingsRepository, ChannelsRepository, UsersRepository } from '@/models/index.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';

@Injectable()
export class ChannelService {
	constructor(
		@Inject(DI.channelsRepository)
		private channelsRepository: ChannelsRepository,

		@Inject(DI.channelFollowingsRepository)
		private channelFollowingsRepository: ChannelFollowingsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

	) {
	}

	@bindThis
	public async getChannel(id: string): Promise<Channel | null> {
		const channel = await this.channelsRepository.findOneBy({ id: id });
		if (!channel) return null;
		return channel;
	}

	@bindThis
	public async isPublic(id: string): Promise<boolean> {
		const channel = await this.channelsRepository.findOneByOrFail({ id: id });
		return channel.isPublic;
	}

	@bindThis
	public async isFolloing(channelId: string, userId: string): Promise<boolean> {
		const channelFollowing = await this.channelFollowingsRepository.findOneBy({
			followeeId: channelId,
			followerId: userId,
		});
		return !!channelFollowing;
	}

	@bindThis
	public async isOwner(channelId: string, userId: string): Promise<boolean> {
		const channel = await this.channelsRepository.findOneByOrFail({ id: channelId });
		return channel.userId === userId;
	}
}
