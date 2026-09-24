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
-- Table structure for admin_key
-- ----------------------------
DROP TABLE IF EXISTS `admin_key`;
CREATE TABLE `admin_key`  (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '管理员密钥ID',
  `key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '管理员密钥明文或密钥哈希值，建议后续存哈希',
  `enabled` tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用该管理员密钥：1=启用，0=禁用',
  `last_login_at` datetime NULL DEFAULT NULL COMMENT '该管理员密钥最近一次验证成功时间',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '该管理员密钥创建时间',
  `updated_at` datetime NULL DEFAULT NULL COMMENT '该管理员密钥最后更新时间',
  `location` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '该管理员密钥绑定的地点英文标识，对应 locat 表 locat_en',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_admin_key`(`key` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 6 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '管理员密钥表' ROW_FORMAT = DYNAMIC;

-- ----------------------------
-- Records of admin_key
-- ----------------------------
-- 仅用于本地演示，部署前请立即替换为随机密钥。
INSERT INTO `admin_key` VALUES (1, 'demo-admin-key', 1, NULL, '2025-01-01 00:00:00', NULL, '*');
INSERT INTO `admin_key` VALUES (2, 'demo-admin-key-2', 1, NULL, '2025-01-01 00:00:00', NULL, '*');

SET FOREIGN_KEY_CHECKS = 1;
