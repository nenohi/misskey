import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from '../id.js';
import { User } from './User.js';
import { Channel } from './Channel.js';

@Entity()
@Index(['channelId', 'followeeId'], { unique: true })
export class ChannelFollowRequest {
	@PrimaryColumn(id())
	public id: string;

	@Column('timestamp with time zone', {
		comment: 'The created date of the FollowRequest.',
	})
	public createdAt: Date;

	@Index()
	@Column({
		...id(),
		comment: 'The followee channel ID.',
	})
	public channelId: Channel['id'];

	@ManyToOne(type => User, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public channel: Channel;

	@Index()
	@Column({
		...id(),
		comment: 'The follower user ID.',
	})
	public userId: User['id'];

	@ManyToOne(type => User, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public user: User | null;

	//#endregion
}
