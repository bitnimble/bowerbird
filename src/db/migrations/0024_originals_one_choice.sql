-- Dialling side only: on a device that is dialled, 0 would refuse its peers' pushes.
UPDATE `replication_libraries` SET `sync_originals` = 0
 WHERE `auto_transfer_originals` = 0
   AND EXISTS (SELECT 1 FROM `replication_peers` p
                WHERE p.`library_id` = `replication_libraries`.`library_id`
                  AND p.`address` IS NOT NULL AND p.`kind` = 'active');
--> statement-breakpoint
ALTER TABLE `replication_libraries` DROP COLUMN `auto_transfer_originals`;
