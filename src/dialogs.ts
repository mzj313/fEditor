/** 模态弹窗：确认框、提示框与单行输入，从 main.ts 拆出，行为保持不变 */

const modal = document.getElementById("modal") as HTMLDivElement;
const modalMessage = document.getElementById("modal-message") as HTMLElement;
/** 快捷键分流时需要判断焦点是否在本弹窗输入框里，故对外暴露 */
export const modalInput = document.getElementById("modal-input") as HTMLInputElement;
const modalActions = document.getElementById("modal-actions") as HTMLDivElement;

export function ask(
  message: string,
  buttons: { label: string; value: string; primary?: boolean }[],
): Promise<string> {
  return new Promise((resolve) => {
    modalMessage.textContent = message;
    modalInput.hidden = true;
    modalActions.replaceChildren(
      ...buttons.map((item) => {
        const button = document.createElement("button");
        button.textContent = item.label;
        if (item.primary) button.className = "primary";
        button.addEventListener("click", () => {
          modal.hidden = true;
          resolve(item.value);
        });
        return button;
      }),
    );
    modal.hidden = false;
  });
}

export function message(text: string): Promise<string> {
  return ask(text, [{ label: "知道了", value: "ok", primary: true }]);
}

/** 单行文本输入弹窗：提交信息、分支名等一次性输入，取消时返回 null */
export function promptText(title: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    modalMessage.textContent = title;
    modalInput.value = initial;
    modalInput.hidden = false;
    modalActions.replaceChildren();

    const finish = (value: string | null) => {
      modal.hidden = true;
      modalInput.hidden = true;
      modalInput.onkeydown = null;
      resolve(value);
    };

    const confirm = document.createElement("button");
    confirm.textContent = "确定";
    confirm.className = "primary";
    confirm.addEventListener("click", () => {
      const value = modalInput.value.trim();
      finish(value ? value : null);
    });

    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => finish(null));

    modalActions.append(confirm, cancel);
    // 回车确认、Esc 取消，避免必须动鼠标
    modalInput.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        confirm.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel.click();
      }
    };

    modal.hidden = false;
    modalInput.focus();
    modalInput.select();
  });
}
