// 学生页由后端同源提供，使用当前页面地址可避免把部署域名写进源码。
const API_BASE_URL = window.location.origin;
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    const confirmModal = document.getElementById("confirmModal");
    const modalConfirmBtn = document.getElementById("modalConfirmBtn");
    const modalCancelBtn = document.getElementById("modalCancelBtn");
    const modalCloseBtn = document.getElementById("modalCloseBtn");
    const confirmStudentId = document.getElementById("confirmStudentId");
    const confirmStudentName = document.getElementById("confirmStudentName");
    const confirmAction = document.getElementById("confirmAction");
    const appLoading = document.getElementById("appLoading");
    const appLoadingText = document.getElementById("appLoadingText");
    const appToast = document.getElementById("appToast");
    const appToastIcon = document.getElementById("appToastIcon");
    const appToastText = document.getElementById("appToastText");
    const attendanceForm = document.getElementById("attendanceForm");
    const studentIdInput = document.getElementById("studentId");
    const studentNameInput = document.getElementById("studentName");
    const studentIdPattern = /^\d{6,12}$/;
    let confirmResolver = null;
    let toastTimer = null;

    function setLoading(visible, text = "正在提交...") {
      appLoadingText.textContent = text;
      appLoading.classList.toggle("is-open", Boolean(visible));
    }

    function hideToast() {
      appToast.classList.remove("is-open");
    }

    function showToast(message, type = "info", duration = 2200) {
      const iconMap = {
        success: "✓",
        error: "!",
        info: "i"
      };

      appToastText.textContent = message || "";
      appToastIcon.textContent = iconMap[type] || iconMap.info;
      appToast.classList.remove("app-toast--success", "app-toast--error", "app-toast--info");
      appToast.classList.add(`app-toast--${type}`);
      appToast.classList.add("is-open");

      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      if (duration > 0) {
        toastTimer = setTimeout(hideToast, duration);
      }
    }

    function markInputInvalid(input, message) {
      input.classList.add("input-invalid");
      input.focus();
      showToast(message, "error", 2400);
    }

    function clearInputInvalid(input) {
      input.classList.remove("input-invalid");
    }

    function closeConfirmModal(confirmed) {
      if (!confirmResolver) return;
      confirmModal.classList.remove("is-open");
      confirmModal.setAttribute("aria-hidden", "true");
      const resolve = confirmResolver;
      confirmResolver = null;
      resolve(Boolean(confirmed));
    }

    function openConfirmModal(payload) {
      const { studentId, studentName, action } = payload;
      confirmStudentId.textContent = studentId;
      confirmStudentName.textContent = studentName;
      confirmAction.textContent = action;
      confirmAction.classList.toggle("confirm-value-action--in", action === "签到");
      confirmAction.classList.toggle("confirm-value-action--out", action === "签退");
      confirmModal.classList.add("is-open");
      confirmModal.setAttribute("aria-hidden", "false");
      return new Promise((resolve) => {
        confirmResolver = resolve;
      });
    }

    modalCancelBtn.addEventListener("click", () => closeConfirmModal(false));
    modalConfirmBtn.addEventListener("click", () => closeConfirmModal(true));
    modalCloseBtn.addEventListener("click", () => closeConfirmModal(false));
    confirmModal.addEventListener("click", (event) => {
      if (event.target === confirmModal) {
        closeConfirmModal(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && confirmModal.classList.contains("is-open")) {
        closeConfirmModal(false);
      }
    });


    document
      attendanceForm
      .addEventListener("submit", async function (event) {
        event.preventDefault();

        clearInputInvalid(studentIdInput);
        clearInputInvalid(studentNameInput);

        const studentId = studentIdInput.value.trim();
        const studentName = studentNameInput.value.trim();
        const action = document.querySelector(
          'input[name="action"]:checked'
        )?.value;

        studentIdInput.value = studentId;
        studentNameInput.value = studentName;

        if (!studentId) {
          markInputInvalid(studentIdInput, "请输入学号");
          return;
        }

        if (!studentIdPattern.test(studentId)) {
          markInputInvalid(studentIdInput, "学号需为 6-12 位数字");
          return;
        }

        if (!studentName) {
          markInputInvalid(studentNameInput, "请输入姓名");
          return;
        }

        if (!action) {
          showToast("请选择操作类型", "error", 2200);
          return;
        }

        const confirmed = await openConfirmModal({ studentId, studentName, action });
        if (!confirmed) return;

        setLoading(true, "正在提交...");

        try {
          const response = await fetch(`${API_BASE_URL}/submit-info`, {
            method: "POST",
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              name: studentName,
              studentId: studentId,
              token: token,
              actionType: action,
            }),
          });

          let data = {};
          try {
            data = await response.json();
          } catch (parseError) {
            console.error("解析响应失败:", parseError);
          }

          if (data.message === "操作成功") {
            const actionMessage = action === "签到" ? "签到成功！" : "签退成功！";
            showToast(actionMessage, "success", 5000);

            // 根据后端返回的地点配置播放对应音频
            if (data.audioEnabled === true) {
              const audioFile = action === "签到" ? "static/audio/begin.mp3" : "static/audio/end.mp3";
              const audio = new Audio(audioFile);
              audio.play().catch(err => console.log("音频播放失败:", err));
            }

            // 使用 setTimeout 延迟跳转
            setTimeout(function () {
              window.location.replace("/");
            }, 3000);
          } else {
            let messageText = data.message || "提交失败，请稍后再试";
            if (typeof messageText === "string" && messageText.includes("在岗人数已达上限")) {
              messageText = `${messageText}，当前地点人数已满，请选择其他地点或稍后再试`;
            }
            showToast(`${messageText}`, "error", 5000);
          }
        } catch (error) {
          console.error("提交失败:", error);
          showToast("服务器错误，请稍后再试", "error", 3200);
        } finally {
          setLoading(false);
        }
      });

    studentIdInput.addEventListener("input", function () {
      if (this.value.trim()) {
        clearInputInvalid(this);
      }
    });

    studentNameInput.addEventListener("input", function () {
      if (this.value.trim()) {
        clearInputInvalid(this);
      }
    });

    studentIdInput.addEventListener("blur", function () {
      const studentId = this.value.trim();
      if (!studentIdPattern.test(studentId)) return;
      // 获取地址栏中的 locact 参数
      if (!token) {
        console.error("缺少 token 参数");
        return;
      }
      fetch(`${API_BASE_URL}/query-last-action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ studentId: studentId, token: token }), // 使用 token 由后端反查地点
      })
        .then((response) => response.json())
        .then((data) => {
          // 先取消选中所有 radio 按钮
          document.querySelectorAll('input[name="action"]').forEach(radio => radio.checked = false);

          const action = data?.actionType?.trim?.();  // 安全地尝试取字符串

          if (action === "签到") {
            document.querySelector('input[name="action"][value="签退"]').checked = true;
          } else if (action === "签退") {
            document.querySelector('input[name="action"][value="签到"]').checked = true;
          } else {
            // 如果既不是“签到”也不是“签退”，默认选中“签到”
            document.querySelector('input[name="action"][value="签到"]').checked = true;
          }
        })

        .catch((err) => {
          console.error("查询签到状态失败:", err);
        });
    });
