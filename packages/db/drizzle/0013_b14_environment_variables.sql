CREATE TABLE `build_environments` (
	`build_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36) NOT NULL,
	CONSTRAINT `build_environments_build_id` PRIMARY KEY(`build_id`)
);
--> statement-breakpoint
CREATE TABLE `environment_variables` (
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`kind` enum('plain','secret') NOT NULL,
	`plain_value` text,
	`encrypted_value` text,
	`updated_by` varchar(36) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `environment_variables_environment_id_name_pk` PRIMARY KEY(`environment_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `variable_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`kind` enum('plain','secret') NOT NULL,
	`actor_user_id` varchar(36) NOT NULL,
	`action` enum('create','update','delete') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `variable_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `build_environments` ADD CONSTRAINT `build_environment_build_fk` FOREIGN KEY (`project_id`,`build_id`) REFERENCES `builds`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `build_environments` ADD CONSTRAINT `build_environment_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `environment_variables` ADD CONSTRAINT `variables_project_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `variable_audit` ADD CONSTRAINT `variable_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `variable_audit_project_time_idx` ON `variable_audit` (`project_id`,`created_at`);