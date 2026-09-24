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
-- Table structure for user_key
-- ----------------------------
DROP TABLE IF EXISTS `user_key`;
CREATE TABLE `user_key`  (
  `id` int NOT NULL AUTO_INCREMENT,
  `key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '密钥',
  `enabled` tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用该普通密钥：1=启用，0=禁用',
  `forced_logout_at` datetime NULL DEFAULT NULL COMMENT '管理员最近一次强制下线该密钥的时间，用于判断旧缓存会话是否失效',
  `last_login_at` datetime NULL DEFAULT NULL COMMENT '该普通密钥最近一次验证成功或重新登录的时间',
  `online` tinyint(1) NOT NULL DEFAULT 0 COMMENT '该普通密钥当前是否在线：1=在线，0=离线，主要用于后台展示',
  `updated_at` datetime NULL DEFAULT NULL COMMENT '该普通密钥状态最后更新时间',
  `location` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '该普通密钥绑定的地点英文标识，对应 locat 表 locat_en',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 7 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci ROW_FORMAT = DYNAMIC;

-- ----------------------------
-- Records of user_key
-- ----------------------------
-- 仅用于本地演示，部署前请立即替换为随机密钥。
INSERT INTO `user_key` VALUES (1, 'demo-user-key-a', 1, NULL, NULL, 0, NULL, 'demo-a');
INSERT INTO `user_key` VALUES (2, 'demo-user-key-b', 1, NULL, NULL, 0, NULL, 'demo-b');
INSERT INTO `user_key` VALUES (3, 'demo-user-key-c', 1, NULL, NULL, 0, NULL, 'demo-c');
INSERT INTO `user_key` VALUES (4, 'demo-user-key-d', 1, NULL, NULL, 0, NULL, 'demo-d');
INSERT INTO `user_key` VALUES (5, 'demo-user-key-e', 1, NULL, NULL, 0, NULL, 'demo-e');

SET FOREIGN_KEY_CHECKS = 1;
