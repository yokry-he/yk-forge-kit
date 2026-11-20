CREATE TABLE `domain_log_chunks` (
	`operation_id` varchar(36) NOT NULL,
	`seq` int unsigned NOT NULL,
	`stream` enum('stdout','stderr','system') NOT NULL,
	`content` text NOT NULL,
	`ts` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `domain_log_chunks_operation_id_seq_pk` PRIMARY KEY(`operation_id`,`seq`)
);
--> statement-breakpoint
CREATE TABLE `domain_operations` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`deploy_target_id` varchar(36) NOT NULL,
	`domain_id` varchar(36) NOT NULL,
	`actor_user_id` varchar(36) NOT NULL,
	`action` enum('verify','refresh','remove') NOT NULL,
	`status` enum('pending','running','succeeded','failed') NOT NULL DEFAULT 'pending',
	`error_code` varchar(64),
	`finished_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `domain_operations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`deploy_target_id` varchar(36) NOT NULL,
	`hostname` varchar(253) NOT NULL,
	`claimed_hostname` varchar(253),
	`verification_token` varchar(64) NOT NULL,
	`status` enum('pending_dns','verifying','issuing','active','failed','expired','revoked') NOT NULL DEFAULT 'pending_dns',
	`tls_mode` enum('internal','staging','production') NOT NULL DEFAULT 'internal',
	`certificate_expires_at` timestamp(3),
	`certificate_fingerprint` varchar(64),
	`verified_at` timestamp(3),
	`last_checked_at` timestamp(3),
	`error_code` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `domains_id` PRIMARY KEY(`id`),
	CONSTRAINT `domains_hostname_claim_unique` UNIQUE(`claimed_hostname`)
);
--> statement-breakpoint
ALTER TABLE `domain_log_chunks` ADD CONSTRAINT `domain_log_chunks_operation_id_domain_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `domain_operations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `domain_operations` ADD CONSTRAINT `domain_operations_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `domains` ADD CONSTRAINT `domains_project_target_fk` FOREIGN KEY (`project_id`,`deploy_target_id`) REFERENCES `deploy_targets`(`project_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `domain_operations_target_status_idx` ON `domain_operations` (`deploy_target_id`,`status`);--> statement-breakpoint
CREATE INDEX `domain_operations_status_updated_idx` ON `domain_operations` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `domains_project_target_idx` ON `domains` (`project_id`,`deploy_target_id`);--> statement-breakpoint
CREATE INDEX `domains_status_checked_idx` ON `domains` (`status`,`last_checked_at`);