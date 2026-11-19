CREATE TABLE `build_log_chunks` (
	`build_id` varchar(36) NOT NULL,
	`seq` int unsigned NOT NULL,
	`stream` enum('stdout','stderr','system') NOT NULL,
	`content` text NOT NULL,
	`ts` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `build_log_chunks_build_id_seq_pk` PRIMARY KEY(`build_id`,`seq`)
);
--> statement-breakpoint
CREATE TABLE `builds` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`number` int unsigned NOT NULL,
	`template` varchar(32) NOT NULL,
	`source_ref` varchar(1024) NOT NULL,
	`status` enum('queued','running','succeeded','failed','canceled','timed_out') NOT NULL DEFAULT 'queued',
	`triggered_by` varchar(36) NOT NULL,
	`queued_at` timestamp(3) NOT NULL DEFAULT (now()),
	`started_at` timestamp(3),
	`finished_at` timestamp(3),
	`exit_code` int,
	`error_message` text,
	`artifact_key` varchar(1024),
	`artifact_size` bigint unsigned,
	`artifact_sha256` varchar(64),
	`log_storage_key` varchar(1024),
	`runner_info` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `builds_id` PRIMARY KEY(`id`),
	CONSTRAINT `builds_project_number_unique` UNIQUE(`project_id`,`number`),
	CONSTRAINT `builds_project_id_unique` UNIQUE(`project_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `deploy_targets` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`kind` enum('ssh') NOT NULL DEFAULT 'ssh',
	`name` varchar(150) NOT NULL,
	`host` varchar(255),
	`port` int unsigned,
	`username` varchar(150),
	`created_by` varchar(36) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `deploy_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `deploy_targets_project_id_unique` UNIQUE(`project_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`environment_id` varchar(36) NOT NULL,
	`deploy_target_id` varchar(36) NOT NULL,
	`status` enum('pending','running','succeeded','failed','canceled','rolled_back') NOT NULL DEFAULT 'pending',
	`started_at` timestamp(3),
	`finished_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `deployments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `environments` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `environments_id` PRIMARY KEY(`id`),
	CONSTRAINT `environments_project_name_unique` UNIQUE(`project_id`,`name`),
	CONSTRAINT `environments_project_id_unique` UNIQUE(`project_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `preview_links` (
	`id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`revoked_at` timestamp(3),
	`created_by` varchar(36) NOT NULL,
	`last_accessed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `preview_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `preview_links_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `build_log_chunks` ADD CONSTRAINT `build_log_chunks_build_id_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `builds` ADD CONSTRAINT `builds_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `builds` ADD CONSTRAINT `builds_triggered_by_users_id_fk` FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD CONSTRAINT `deploy_targets_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD CONSTRAINT `deploy_targets_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployments` ADD CONSTRAINT `deployments_project_build_fk` FOREIGN KEY (`project_id`,`build_id`) REFERENCES `builds`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployments` ADD CONSTRAINT `deployments_project_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployments` ADD CONSTRAINT `deployments_project_target_fk` FOREIGN KEY (`project_id`,`deploy_target_id`) REFERENCES `deploy_targets`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `preview_links` ADD CONSTRAINT `preview_links_build_id_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `preview_links` ADD CONSTRAINT `preview_links_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `builds_project_status_idx` ON `builds` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `deployments_project_environment_status_idx` ON `deployments` (`project_id`,`environment_id`,`status`);--> statement-breakpoint
CREATE INDEX `preview_links_build_expiry_idx` ON `preview_links` (`build_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `preview_links_expiry_idx` ON `preview_links` (`expires_at`);