CREATE TABLE `project_invitation_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`invitation_id` varchar(36) NOT NULL,
	`actor_user_id` varchar(36) NOT NULL,
	`action` varchar(16) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `project_invitation_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `project_invitations` ADD `revoked_at` timestamp;--> statement-breakpoint
ALTER TABLE `project_invitations` ADD `revoked_by_user_id` varchar(36);--> statement-breakpoint
ALTER TABLE `project_invitation_audit` ADD CONSTRAINT `project_invitation_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `project_invitation_audit_project_time_idx` ON `project_invitation_audit` (`project_id`,`created_at`);