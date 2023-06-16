import { PrimaryColumn, Entity, Index, Column } from 'typeorm';
import { id } from '../id.js';
import { User } from './User.js';
import { Channel } from './Channel.js';

@Entity()
@Index(['blockerId', 'channelId'], { unique: true })
export class ChannelBlockee {
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
		comment: 'The blockee channel ID.',
	})
	public channelId: Channel['id'];

	@Index()
	@Column({
		...id(),
		comment: 'The blocker user ID.',
	})
	public blockerId: User['id'];
}
