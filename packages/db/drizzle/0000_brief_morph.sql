CREATE TABLE `asset_installations` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`asset_id` varchar(128) NOT NULL,
	`version` varchar(32) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `asset_installations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` varchar(36) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`name` varchar(150) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `asset_installations` ADD CONSTRAINT `asset_installations_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;