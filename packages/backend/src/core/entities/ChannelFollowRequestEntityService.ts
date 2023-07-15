import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { ChannelFollowRequestsRepository } from '@/models/index.js';
import type { } from '@/models/entities/Blocking.js';
import type { User } from '@/models/entities/User.js';
import type { ChannelFollowRequest } from '@/models/entities/ChannelFollowRequest.js';
import { UserEntityService } from './UserEntityService.js';
import { ChannelEntityService } from './ChannelEntityService.js';
import { bindThis } from '@/decorators.js';

@Injectable()
export class FollowRequestEntityService {
	constructor(
		@Inject(DI.followRequestsRepository)
		private channelFollowRequestsRepository: ChannelFollowRequestsRepository,

		private userEntityService: UserEntityService,
		private channelEntityService: ChannelEntityService,
	) {
	}

	@bindThis
	public async pack(
		src: ChannelFollowRequest['id'] | ChannelFollowRequest,
		me?: { id: User['id'] } | null | undefined,
	) {
		const request = typeof src === 'object' ? src : await this.channelFollowRequestsRepository.findOneByOrFail({ id: src });

		return {
			id: request.id,
			channelId: await this.channelEntityService.pack(request.channelId, me),
			follower: await this.userEntityService.pack(request.followerId, me),
		};
	}
}

