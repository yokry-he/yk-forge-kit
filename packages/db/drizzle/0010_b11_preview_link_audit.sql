CREATE TABLE `preview_link_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`preview_link_id` varchar(36) NOT NULL,
	`actor_user_id` varchar(36) NOT NULL,
	`action` varchar(16) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `preview_link_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `preview_link_audit` ADD CONSTRAINT `preview_link_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `preview_link_audit` ADD CONSTRAINT `preview_link_audit_build_id_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `preview_link_audit_project_time_idx` ON `preview_link_audit` (`project_id`,`created_at`);