CREATE TABLE `weapp_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`job_id` varchar(36),
	`actor_user_id` varchar(36) NOT NULL,
	`action` enum('config_saved','config_deleted','triggered') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `weapp_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `weapp_configs` (
	`project_id` varchar(36) NOT NULL,
	`app_id` varchar(32) NOT NULL,
	`encrypted_private_key` text NOT NULL,
	`ip_whitelist_note` varchar(1000) NOT NULL DEFAULT '',
	`updated_by` varchar(36) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `weapp_configs_project_id` PRIMARY KEY(`project_id`)
);
--> statement-breakpoint
CREATE TABLE `weapp_jobs` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`app_id` varchar(32) NOT NULL,
	`input` json NOT NULL,
	`status` enum('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
	`triggered_by` varchar(36) NOT NULL,
	`error_code` varchar(64),
	`qr_artifact_key` varchar(1024),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`started_at` timestamp(3),
	`finished_at` timestamp(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `weapp_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `weapp_log_chunks` (
	`job_id` varchar(36) NOT NULL,
	`seq` int unsigned NOT NULL,
	`stream` enum('stdout','stderr','system') NOT NULL,
	`content` text NOT NULL,
	`ts` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `weapp_log_chunks_job_id_seq_pk` PRIMARY KEY(`job_id`,`seq`)
);
--> statement-breakpoint
ALTER TABLE `builds` ADD `target` enum('h5','mp-weixin') DEFAULT 'h5' NOT NULL;--> statement-breakpoint
ALTER TABLE `weapp_audit` ADD CONSTRAINT `weapp_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `weapp_configs` ADD CONSTRAINT `weapp_configs_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `weapp_jobs` ADD CONSTRAINT `weapp_project_build_fk` FOREIGN KEY (`project_id`,`build_id`) REFERENCES `builds`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `weapp_log_chunks` ADD CONSTRAINT `weapp_log_chunks_job_id_weapp_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `weapp_jobs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `weapp_audit_project_time_idx` ON `weapp_audit` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `weapp_jobs_status_updated_idx` ON `weapp_jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `weapp_jobs_project_created_idx` ON `weapp_jobs` (`project_id`,`created_at`);