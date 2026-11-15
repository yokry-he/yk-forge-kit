CREATE TABLE `project_invitations` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`role` varchar(16) NOT NULL,
	`created_by_user_id` varchar(36) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`expires_at` timestamp NOT NULL,
	`redeemed_at` timestamp,
	`redeemed_by_user_id` varchar(36),
	CONSTRAINT `project_invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `project_invitations_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `project_invitations` ADD CONSTRAINT `project_invitations_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `project_invitation_project_expiry_idx` ON `project_invitations` (`project_id`,`expires_at`);