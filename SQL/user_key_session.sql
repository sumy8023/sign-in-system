/*
 Navicat Premium Dump SQL

 Source Server         : local development
 Source Server Type    : MySQL
 Source Server Version : 80030 (8.0.30-cynos)
 Source Host           : 127.0.0.1:3306
 Source Schema         : qiandao_demo

 Target Server Type    : MySQL
 Target Server Version : 80030 (8.0.30-cynos)
 File Encoding         : 65001

 Date: 01/01/2025 00:00:00
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for user_key_session
-- ----------------------------
DROP TABLE IF EXISTS `user_key_session`;
CREATE TABLE `user_key_session`  (
  `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_key_id` bigint NOT NULL,
  `session_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `location` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT '',
  `created_at` datetime NOT NULL,
  `last_seen_at` datetime NOT NULL,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uniq_user_key_session`(`user_key_id` ASC, `session_id` ASC) USING BTREE,
  INDEX `idx_user_key_last_seen`(`user_key_id` ASC, `last_seen_at` ASC) USING BTREE,
  INDEX `idx_last_seen`(`last_seen_at` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 162 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of user_key_session
-- ----------------------------

SET FOREIGN_KEY_CHECKS = 1;
