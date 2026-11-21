CREATE TABLE `runtime_log_chunks` (
	`session_id` varchar(36) NOT NULL,
	`seq` int unsigned NOT NULL,
	`stream` enum('stdout','stderr','system') NOT NULL,
	`content` text NOT NULL,
	`ts` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `runtime_log_chunks_session_id_seq_pk` PRIMARY KEY(`session_id`,`seq`)
);
--> statement-breakpoint
CREATE TABLE `runtime_log_sessions` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`domain_id` varchar(36) NOT NULL,
	`deploy_target_id` varchar(36) NOT NULL,
	`actor_user_id` varchar(36) NOT NULL,
	`host_hash` varchar(64) NOT NULL,
	`input` json NOT NULL,
	`status` enum('pending','running','ended','canceled','failed') NOT NULL DEFAULT 'pending',
	`error_code` varchar(64),
	`bytes` int unsigned NOT NULL DEFAULT 0,
	`last_seq` int unsigned NOT NULL DEFAULT 0,
	`lease_owner` varchar(36),
	`lease_until` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `runtime_log_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `runtime_log_chunks` ADD CONSTRAINT `runtime_log_chunks_session_id_runtime_log_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `runtime_log_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runtime_log_sessions` ADD CONSTRAINT `runtime_log_sessions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runtime_log_sessions` ADD CONSTRAINT `runtime_log_sessions_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `runtime_sessions_expiry_idx` ON `runtime_log_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `runtime_sessions_status_idx` ON `runtime_log_sessions` (`status`);