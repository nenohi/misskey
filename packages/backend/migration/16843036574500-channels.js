export class channels16843036574500 {
	name = 'channels16843036574500'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "channel" ADD "isPublic" boolean NOT NULL DEFAULT true`);
	}

	async down(queryRunner) {
			await queryRunner.query(`ALTER TABLE "channel" DROP COLUMN "isPublic"`);
	}
}
