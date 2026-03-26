CREATE TABLE IF NOT EXISTS `site_allowed_models` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `model_name` TEXT NOT NULL, `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE);
ALTER TABLE `sites` ADD COLUMN `model_filter_mode` VARCHAR(191) DEFAULT 'deny-list';
CREATE UNIQUE INDEX `site_allowed_models_site_model_unique` ON `site_allowed_models` (`site_id`, `model_name`(191));
CREATE INDEX `site_allowed_models_site_id_idx` ON `site_allowed_models` (`site_id`);
