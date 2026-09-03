import { syncAnchoredOverlay } from "../../../components/anchored-overlay.ts";
import { consumeTooltipEscape } from "../../../components/tooltip.ts";

const MOBILE_COMPOSER_OVERLAY_QUERY =
  "(max-width: 640px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

const CHAT_COMPOSER_PICKER_DOCUMENT_STATE = Symbol.for(
  "openclaw.chat-composer-picker-document-state",
);
const POINTER_RESTORED_FOCUS_ATTRIBUTE = "data-chat-pointer-restored-focus";
const POINTER_OPENED_PICKER_ATTRIBUTE = "data-chat-pointer-opened-picker";
const CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT = "openclaw-composer-dismiss-invocations";

type ChatComposerPickerDocumentState = {
  dismissalInstalled: boolean;
  pointerOpenedDropdowns: WeakSet<HTMLElement>;
};

function isRealmHTMLElement(value: unknown): value is HTMLElement {
  if (!value || typeof value !== "object" || !("ownerDocument" in value)) {
    return false;
  }
  const ownerDocument = (value as { ownerDocument?: Document | null }).ownerDocument;
  const HTMLElementConstructor = ownerDocument?.defaultView?.HTMLElement;
  return HTMLElementConstructor
    ? value instanceof HTMLElementConstructor
    : value instanceof HTMLElement;
}

function isDetailsPicker(picker: HTMLElement): picker is HTMLDetailsElement {
  return picker.localName === "details";
}

function chatComposerPickerDocumentState(ownerDocument: Document): ChatComposerPickerDocumentState {
  const existing = Reflect.get(ownerDocument, CHAT_COMPOSER_PICKER_DOCUMENT_STATE) as
    | ChatComposerPickerDocumentState
    | undefined;
  if (existing) {
    return existing;
  }
  const created: ChatComposerPickerDocumentState = {
    dismissalInstalled: false,
    pointerOpenedDropdowns: new WeakSet<HTMLElement>(),
  };
  Object.defineProperty(ownerDocument, CHAT_COMPOSER_PICKER_DOCUMENT_STATE, {
    configurable: true,
    value: created,
  });
  return created;
}

function composerPickerIsOpen(picker: HTMLElement): boolean {
  if (isDetailsPicker(picker)) {
    return picker.open;
  }
  return ("open" in picker && picker.open === true) || picker.hasAttribute("open");
}

function openChatComposerPickers(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ".agent-chat__input details, .agent-chat__input wa-dropdown",
    ),
  ).filter(composerPickerIsOpen);
}

function closeComposerPicker(picker: HTMLElement): void {
  chatComposerPickerDocumentState(picker.ownerDocument).pointerOpenedDropdowns.delete(picker);
  picker.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
  if (isDetailsPicker(picker)) {
    picker.open = false;
  } else {
    if ("open" in picker) {
      picker.open = false;
    }
    picker.removeAttribute("open");
  }
}

function pickerTrigger(picker: HTMLElement): HTMLElement | null {
  return isDetailsPicker(picker)
    ? picker.querySelector<HTMLElement>("summary")
    : picker.querySelector<HTMLElement>("[slot=trigger]");
}

function dispatchDismissInvocations(composer: Element): void {
  const EventConstructor = composer.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
  composer.dispatchEvent(new EventConstructor(CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT));
}

function dismissChatComposerPickersOutside(event: PointerEvent, ownerDocument: Document): void {
  const path = event.composedPath();
  for (const picker of openChatComposerPickers(ownerDocument)) {
    if (!path.includes(picker)) {
      closeComposerPicker(picker);
    }
  }
  for (const menu of ownerDocument.querySelectorAll<HTMLElement>(
    ".agent-chat__input > :is(.slash-menu, .skill-menu)",
  )) {
    if (!path.includes(menu)) {
      const composer = menu.closest(".agent-chat__input");
      if (composer) {
        dispatchDismissInvocations(composer);
      }
    }
  }
}

function dismissChatComposerPickersOnEscape(event: KeyboardEvent, ownerDocument: Document): void {
  if (
    event.defaultPrevented ||
    consumeTooltipEscape(event, ownerDocument) ||
    event.key !== "Escape" ||
    ownerDocument.querySelector(".shell-nav[aria-modal='true']")
  ) {
    return;
  }
  const pickers = openChatComposerPickers(ownerDocument);
  const invocationComposer = ownerDocument
    .querySelector<HTMLElement>(".agent-chat__input > :is(.slash-menu, .skill-menu)")
    ?.closest<HTMLElement>(".agent-chat__input");
  if (pickers.length === 0 && !invocationComposer) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const lastPicker = pickers.at(-1);
  pickers.forEach(closeComposerPicker);
  if (invocationComposer) {
    dispatchDismissInvocations(invocationComposer);
  }
  invocationComposer
    ?.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
    ?.focus({ preventScroll: true });
  if (lastPicker) {
    pickerTrigger(lastPicker)?.focus({ preventScroll: true });
  }
}

export function ensureChatComposerPickerDismissal(
  ownerDocument: Document | undefined = typeof document === "undefined" ? undefined : document,
): void {
  if (!ownerDocument) {
    return;
  }
  const state = chatComposerPickerDocumentState(ownerDocument);
  if (state.dismissalInstalled) {
    return;
  }
  state.dismissalInstalled = true;
  ownerDocument.addEventListener(
    "pointerdown",
    (event) => dismissChatComposerPickersOutside(event, ownerDocument),
    true,
  );
  // Window capture observes the open picker before component Escape handlers
  // mutate details.open and erase the return-focus owner.
  ownerDocument.defaultView?.addEventListener(
    "keydown",
    (event) => dismissChatComposerPickersOnEscape(event, ownerDocument),
    true,
  );
  ownerDocument.addEventListener(
    "keydown",
    (event) => {
      const dropdown = event
        .composedPath()
        .find(
          (node): node is HTMLElement =>
            isRealmHTMLElement(node) && node.localName === "wa-dropdown",
        );
      if (dropdown) {
        chatComposerPickerDocumentState(dropdown.ownerDocument).pointerOpenedDropdowns.delete(
          dropdown,
        );
        dropdown.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
      }
    },
    true,
  );
}

function closeOtherChatComposerPickers(source: HTMLElement): void {
  const composer = source.closest(".agent-chat__input");
  if (!composer) {
    return;
  }
  for (const picker of openChatComposerPickers(composer)) {
    if (picker !== source) {
      closeComposerPicker(picker);
    }
  }
}

export function handleChatComposerDetailsToggle(event: Event): void {
  const details = event.currentTarget;
  if (isRealmHTMLElement(details) && isDetailsPicker(details) && details.open) {
    ensureChatComposerPickerDismissal(details.ownerDocument);
    closeOtherChatComposerPickers(details);
  }
}

export function handleChatComposerDropdownShow(event: Event): void {
  const dropdown = event.target;
  if (isRealmHTMLElement(dropdown) && dropdown.localName === "wa-dropdown") {
    if (
      !chatComposerPickerDocumentState(dropdown.ownerDocument).pointerOpenedDropdowns.has(dropdown)
    ) {
      dropdown.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
    }
    ensureChatComposerPickerDismissal(dropdown.ownerDocument);
    closeOtherChatComposerPickers(dropdown);
  }
}

export function markPointerOpenedChatComposerDropdown(event: PointerEvent): void {
  const dropdown = event
    .composedPath()
    .find(
      (node): node is HTMLElement => isRealmHTMLElement(node) && node.localName === "wa-dropdown",
    );
  if (dropdown) {
    chatComposerPickerDocumentState(dropdown.ownerDocument).pointerOpenedDropdowns.add(dropdown);
    dropdown.setAttribute(POINTER_OPENED_PICKER_ATTRIBUTE, "");
  }
}

export function restorePointerOpenedChatComposerTrigger(event: Event): void {
  const dropdown =
    isRealmHTMLElement(event.target) && event.target.localName === "wa-dropdown"
      ? event.target
      : event.currentTarget;
  if (
    isRealmHTMLElement(dropdown) &&
    dropdown.localName === "wa-dropdown" &&
    chatComposerPickerDocumentState(dropdown.ownerDocument).pointerOpenedDropdowns.delete(dropdown)
  ) {
    const trigger = pickerTrigger(dropdown);
    if (!trigger) {
      return;
    }
    trigger.setAttribute(POINTER_RESTORED_FOCUS_ATTRIBUTE, "");
    const clearPointerFocus = () => trigger.removeAttribute(POINTER_RESTORED_FOCUS_ATTRIBUTE);
    trigger.addEventListener("blur", clearPointerFocus, { once: true });
    trigger.addEventListener("keydown", clearPointerFocus, { once: true });
    trigger.focus({ preventScroll: true });
  }
}

export function syncChatPickerOverlay(details: HTMLDetailsElement): void {
  // Mobile panels span the composer, so anchor to that stable box; desktop
  // panels stay attached to the individual trigger.
  const composerAnchor =
    typeof details.ownerDocument.defaultView?.matchMedia === "function" &&
    details.ownerDocument.defaultView.matchMedia(MOBILE_COMPOSER_OVERLAY_QUERY).matches
      ? (details.closest(".agent-chat__input") ?? undefined)
      : undefined;
  syncAnchoredOverlay(details, "top", { alignment: "end", anchor: composerAnchor });
}
