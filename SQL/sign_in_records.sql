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
-- Table structure for sign_in_records
-- ----------------------------
DROP TABLE IF EXISTS `sign_in_records`;
CREATE TABLE `sign_in_records`  (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '姓名',
  `student_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '学号',
  `action_type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '签到状态',
  `location` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '地点',
  `sign_in_time` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '签到时间',
  `sign_out_time` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '签退时间',
  `token` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'token记录',
  `timeadd` decimal(10, 2) GENERATED ALWAYS AS (round((timestampdiff(SECOND,`sign_in_time`,`sign_out_time`) / 3600.0),2)) STORED COMMENT '获得时长' NULL,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 690 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci ROW_FORMAT = DYNAMIC;

SET FOREIGN_KEY_CHECKS = 1;
