CREATE TABLE `project_member_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`actor_user_id` varchar(36) NOT NULL,
	`target_user_id` varchar(36) NOT NULL,
	`previous_role` varchar(16) NOT NULL,
	`next_role` varchar(16) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `project_member_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `project_member_audit` ADD CONSTRAINT `project_member_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `project_member_audit_project_time_idx` ON `project_member_audit` (`project_id`,`created_at`);