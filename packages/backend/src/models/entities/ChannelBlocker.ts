import { PrimaryColumn, Entity, Index, Column } from 'typeorm';
import { id } from '../id.js';
import { User } from './User.js';
import { Channel } from './Channel.js';

@Entity()
@Index(['channelId', 'blockeeId'], { unique: true })
export class ChannelBlocker {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column('timestamp with time zone', {
		comment: 'The created date of the Blocking.',
	})
	public createdAt: Date;

	@Index()
	@Column({
		...id(),
		comment: 'The blockee user ID.',
	})
	public blockeeId: User['id'];

	@Index()
	@Column({
		...id(),
		comment: 'The blocker channel ID.',
	})
	public channelId: Channel['id'];
}
