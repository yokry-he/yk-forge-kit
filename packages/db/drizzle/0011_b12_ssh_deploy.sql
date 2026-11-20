CREATE TABLE `deploy_audit` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`target_id` varchar(36) NOT NULL,
	`deployment_id` varchar(36),
	`actor_user_id` varchar(36) NOT NULL,
	`action` varchar(24) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `deploy_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `deploy_log_chunks` (
	`deployment_id` varchar(36) NOT NULL,
	`seq` int unsigned NOT NULL,
	`stream` enum('stdout','stderr','system') NOT NULL,
	`content` text NOT NULL,
	`ts` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `deploy_log_chunks_deployment_id_seq_pk` PRIMARY KEY(`deployment_id`,`seq`)
);
--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD `host_key` text;--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD `encrypted_private_key` text;--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD `base_path` varchar(255);--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD `retention` int unsigned DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD `current_release_id` varchar(36);--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD `disabled_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `deployments` ADD `action` enum('deploy','rollback') DEFAULT 'deploy' NOT NULL;--> statement-breakpoint
ALTER TABLE `deployments` ADD `release_id` varchar(36);--> statement-breakpoint
ALTER TABLE `deployments` ADD `rollback_of` varchar(36);--> statement-breakpoint
ALTER TABLE `deployments` ADD `triggered_by` varchar(36);--> statement-breakpoint
ALTER TABLE `deployments` ADD `retained` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `deployments` ADD `error_message` varchar(255);--> statement-breakpoint
ALTER TABLE `deploy_audit` ADD CONSTRAINT `deploy_audit_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deploy_log_chunks` ADD CONSTRAINT `deploy_log_chunks_deployment_id_deployments_id_fk` FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `deploy_audit_project_time_idx` ON `deploy_audit` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `deployments_target_status_idx` ON `deployments` (`deploy_target_id`,`status`);
--> statement-breakpoint
CREATE INDEX `deployments_status_updated_idx` ON `deployments` (`status`,`updated_at`);
