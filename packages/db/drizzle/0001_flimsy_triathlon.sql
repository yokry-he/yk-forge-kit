ALTER TABLE `projects` ADD `template` varchar(32) DEFAULT 'vue-web' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `features` json;--> statement-breakpoint
UPDATE `projects` SET `features` = JSON_ARRAY() WHERE `features` IS NULL;--> statement-breakpoint
ALTER TABLE `projects` MODIFY `features` json NOT NULL;
