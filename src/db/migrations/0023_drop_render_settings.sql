-- The camera match and the defringe are per photo, in its edit document (`lensCorrection`,
-- `colourProfile`, `defringe`).
DELETE FROM `settings` WHERE `key` IN ('match_embedded_jpeg', 'raw_defringe');
