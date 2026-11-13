CREATE TABLE `reconstruction_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `request_id` text NOT NULL,
  `remote_id` text,
  `status` text NOT NULL,
  `progress` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `last_polled_at` integer NOT NULL DEFAULT 0,
  `expires_at` integer,
  `assets_json` text,
  `error` text,
  `consent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconstruction_user_request` ON `reconstruction_tasks` (`user_id`,`request_id`);
--> statement-breakpoint
CREATE INDEX `reconstruction_user_created` ON `reconstruction_tasks` (`user_id`,`created_at`);
