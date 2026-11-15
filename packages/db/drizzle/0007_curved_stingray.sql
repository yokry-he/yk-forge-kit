CREATE TABLE `invitation_rate_buckets` (
	`bucket_key` varchar(96) NOT NULL,
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invitation_rate_buckets_bucket_key` PRIMARY KEY(`bucket_key`)
);
--> statement-breakpoint
CREATE INDEX `invitation_rate_bucket_created_idx` ON `invitation_rate_buckets` (`created_at`);