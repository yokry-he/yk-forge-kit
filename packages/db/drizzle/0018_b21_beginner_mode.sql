CREATE TABLE `beginner_ai_configs` (
	`user_id` varchar(36) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`base_url` varchar(512) NOT NULL,
	`model` varchar(128) NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `beginner_ai_configs_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `platforms` json;--> statement-breakpoint
ALTER TABLE `beginner_ai_configs` ADD CONSTRAINT `beginner_ai_configs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;