ALTER TABLE `sites` ADD `model_filter_mode` text DEFAULT 'deny-list';
--> statement-breakpoint
CREATE TABLE `site_allowed_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_allowed_models_site_model_unique` ON `site_allowed_models` (`site_id`,`model_name`);--> statement-breakpoint
CREATE INDEX `site_allowed_models_site_id_idx` ON `site_allowed_models` (`site_id`);
