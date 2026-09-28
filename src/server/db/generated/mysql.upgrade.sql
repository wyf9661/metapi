ALTER TABLE `downstream_api_keys` ADD COLUMN `allowed_site_ids` JSON;
ALTER TABLE `downstream_api_keys` ADD COLUMN `allowed_credential_refs` JSON;
