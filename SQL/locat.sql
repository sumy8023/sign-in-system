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
-- Table structure for locat
-- ----------------------------
DROP TABLE IF EXISTS `locat`;
CREATE TABLE `locat`  (
  `id` int NOT NULL AUTO_INCREMENT,
  `locat_en` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NULL DEFAULT NULL COMMENT '英文地点',
  `locat_cn` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NULL DEFAULT NULL COMMENT '中文地点',
  `max_people` int NULL DEFAULT 0 COMMENT '人数上限',
  `info_text` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT '暂无记录' COMMENT '无人提示文字',
  `audio` tinyint(1) NULL DEFAULT 0 COMMENT '音频开关',
  `enabled` tinyint(1) NULL DEFAULT 1 COMMENT '状态开关',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 7 CHARACTER SET = utf8mb3 COLLATE = utf8mb3_unicode_ci ROW_FORMAT = DYNAMIC;

-- ----------------------------
-- Records of locat
-- ----------------------------
INSERT INTO `locat` VALUES (1, 'demo-a', '演示地点A', 0, '暂无记录', 0, 1);
INSERT INTO `locat` VALUES (2, 'demo-b', '演示地点B', 0, '暂无记录', 0, 1);
INSERT INTO `locat` VALUES (3, 'demo-c', '演示地点C', 0, '暂无记录', 0, 1);
INSERT INTO `locat` VALUES (4, 'demo-d', '演示地点D', 0, '暂无记录', 0, 1);
INSERT INTO `locat` VALUES (6, 'demo-e', '演示地点E', 0, '暂无记录', 0, 1);

SET FOREIGN_KEY_CHECKS = 1;
