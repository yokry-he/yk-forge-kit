CREATE TABLE `build_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`actor_user_id` varchar(36) NOT NULL,
	`action` varchar(16) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `build_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `build_audit` ADD CONSTRAINT `build_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `build_audit` ADD CONSTRAINT `build_audit_build_id_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `build_audit_project_time_idx` ON `build_audit` (`project_id`,`created_at`);