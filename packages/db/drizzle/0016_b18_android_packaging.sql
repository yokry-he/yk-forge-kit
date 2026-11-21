CREATE TABLE `android_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`job_id` varchar(36),
	`actor_user_id` varchar(36) NOT NULL,
	`action` enum('config_saved','config_deleted','triggered','cancel_requested') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `android_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `android_configs` (
	`project_id` varchar(36) NOT NULL,
	`settings` json NOT NULL,
	`encrypted_signing` mediumtext,
	`updated_by` varchar(36) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `android_configs_project_id` PRIMARY KEY(`project_id`)
);
--> statement-breakpoint
CREATE TABLE `android_jobs` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`settings` json NOT NULL,
	`source` json NOT NULL,
	`input` json NOT NULL,
	`status` enum('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
	`triggered_by` varchar(36) NOT NULL,
	`error_code` varchar(64),
	`artifact_key` varchar(1024),
	`artifact` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`started_at` timestamp(3),
	`finished_at` timestamp(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `android_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `android_log_chunks` (
	`job_id` varchar(36) NOT NULL,
	`seq` int unsigned NOT NULL,
	`stream` enum('stdout','stderr','system') NOT NULL,
	`content` text NOT NULL,
	`ts` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `android_log_chunks_job_id_seq_pk` PRIMARY KEY(`job_id`,`seq`)
);
--> statement-breakpoint
ALTER TABLE `android_audit` ADD CONSTRAINT `android_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `android_configs` ADD CONSTRAINT `android_configs_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `android_jobs` ADD CONSTRAINT `android_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `android_log_chunks` ADD CONSTRAINT `android_log_chunks_job_id_android_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `android_jobs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `android_audit_project_time_idx` ON `android_audit` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `android_jobs_status_updated_idx` ON `android_jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `android_jobs_project_created_idx` ON `android_jobs` (`project_id`,`created_at`);