ALTER TABLE `account_tokens` ADD `model_filter_mode` text DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `filtered_models` text;
--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `model_mapping` text;
