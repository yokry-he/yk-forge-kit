CREATE TABLE `alipay_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`job_id` varchar(36),
	`actor_user_id` varchar(36) NOT NULL,
	`action` enum('config_saved','config_deleted','triggered') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `alipay_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alipay_configs` (
	`project_id` varchar(36) NOT NULL,
	`app_id` varchar(32) NOT NULL,
	`encrypted_private_key` text NOT NULL,
	`tool_id` varchar(128) NOT NULL,
	`updated_by` varchar(36) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `alipay_configs_project_id` PRIMARY KEY(`project_id`)
);
--> statement-breakpoint
CREATE TABLE `alipay_jobs` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`app_id` varchar(32) NOT NULL,
	`tool_id` varchar(128) NOT NULL,
	`input` json NOT NULL,
	`status` enum('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
	`triggered_by` varchar(36) NOT NULL,
	`error_code` varchar(64),
	`qr_artifact_key` varchar(1024),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`started_at` timestamp(3),
	`finished_at` timestamp(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `alipay_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alipay_log_chunks` (
	`job_id` varchar(36) NOT NULL,
	`seq` int unsigned NOT NULL,
	`stream` enum('stdout','stderr','system') NOT NULL,
	`content` text NOT NULL,
	`ts` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `alipay_log_chunks_job_id_seq_pk` PRIMARY KEY(`job_id`,`seq`)
);
--> statement-breakpoint
ALTER TABLE `builds` MODIFY COLUMN `target` enum('h5','mp-weixin','mp-alipay') NOT NULL DEFAULT 'h5';--> statement-breakpoint
ALTER TABLE `alipay_audit` ADD CONSTRAINT `alipay_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alipay_configs` ADD CONSTRAINT `alipay_configs_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alipay_jobs` ADD CONSTRAINT `alipay_project_build_fk` FOREIGN KEY (`project_id`,`build_id`) REFERENCES `builds`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alipay_log_chunks` ADD CONSTRAINT `alipay_log_chunks_job_id_alipay_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `alipay_jobs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `alipay_audit_project_time_idx` ON `alipay_audit` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alipay_jobs_status_updated_idx` ON `alipay_jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `alipay_jobs_project_created_idx` ON `alipay_jobs` (`project_id`,`created_at`);