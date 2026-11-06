// fill-helper.js
// This script is injected into the page to handle form filling operations

if (window.__FILL_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__FILL_HELPER_INITIALIZED__ = true;
  /**
   * Fill an input element with the specified value
   * @param {string} selector - CSS selector for the element to fill
   * @param {string} value - Value to fill into the element
   * @returns {Promise<Object>} - Result of the fill operation
   */
  async function fillElement(selector, value, ref = null) {
    try {
      // Find the element
      let element = null;
      if (ref && typeof ref === 'string') {
        try {
          const map = window.__chromeShellElementMap;
          const weak = map && map[ref];
          element = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }
        if (!element || !(element instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }
      } else {
        element = document.querySelector(selector);
      }
      if (!element) {
        return {
          error: selector
            ? `Element with selector "${selector}" not found`
            : `Element for ref not found`,
        };
      }
      const targetDescription = ref ? `ref "${ref}"` : `selector "${selector}"`;

      // Get element information
      const rect = element.getBoundingClientRect();
      const elementInfo = {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        type: element.type || null,
        isVisible: isElementVisible(element),
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
      };

      // A rendered element may initially be outside the viewport. Scroll it
      // first, then perform the stricter viewport/occlusion check.
      if (!isElementRendered(element)) {
        return {
          error: `Element with ${targetDescription} is not rendered`,
          elementInfo,
        };
      }
      element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const scrolledRect = element.getBoundingClientRect();
      elementInfo.isVisible = isElementVisible(element);
      elementInfo.rect = {
        x: scrolledRect.x,
        y: scrolledRect.y,
        width: scrolledRect.width,
        height: scrolledRect.height,
        top: scrolledRect.top,
        right: scrolledRect.right,
        bottom: scrolledRect.bottom,
        left: scrolledRect.left,
      };
      if (!elementInfo.isVisible) {
        return {
          error: `Element with ${targetDescription} is not visible after scrolling`,
          elementInfo,
        };
      }

      const ariaRole = element.getAttribute('role');
      if (element.tagName !== 'INPUT' && ['checkbox', 'switch', 'radio'].includes(ariaRole)) {
        const desired = ariaRole === 'radio' ? true : parseCheckedValue(value);
        if (typeof desired !== 'boolean') return { error: CHECKED_VALUE_ERROR, elementInfo };
        return await setToggle(
          element,
          desired,
          () => element.getAttribute('aria-checked') === 'true',
          elementInfo,
        );
      }

      // Check if element is an input, textarea, or select
      const validTags = ['INPUT', 'TEXTAREA', 'SELECT'];
      // Keep a permissive list to allow type-specific branches below to handle behavior
      const validInputTypes = [
        'text',
        'email',
        'password',
        'number',
        'search',
        'tel',
        'url',
        'date',
        'datetime-local',
        'month',
        'time',
        'week',
        'color',
        'checkbox',
        'radio',
        'range',
      ];

      if (!validTags.includes(element.tagName)) {
        // If the element is a custom element with open shadow root, try to find a fillable inner control
        try {
          const anyEl = /** @type {any} */ (element);
          const sr = anyEl && anyEl.shadowRoot ? anyEl.shadowRoot : null;
          if (sr) {
            // Search common fillable targets inside shadow root (breadth-first)
            const queue = Array.from(sr.children || []);
            const isFillable = (el) =>
              !!el &&
              (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
            while (queue.length) {
              const cur = queue.shift();
              if (!cur) continue;
              if (isFillable(cur)) {
                element = cur;
                break;
              }
              try {
                const children = cur.children || [];
                for (let i = 0; i < children.length; i++) queue.push(children[i]);
                const innerSr = /** @type {any} */ (cur).shadowRoot;
                if (innerSr && innerSr.children) {
                  for (let i = 0; i < innerSr.children.length; i++) queue.push(innerSr.children[i]);
                }
              } catch (_) {}
            }
            if (!validTags.includes(element.tagName)) {
              return {
                error: `Element with ${targetDescription} is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
                elementInfo,
              };
            }
          } else {
            return {
              error: `Element with ${targetDescription} is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
              elementInfo,
            };
          }
        } catch (_) {
          return {
            error: `Element with ${targetDescription} is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
            elementInfo,
          };
        }
      }

      // For input elements, check if the type is valid (allow type-specific branches below)
      if (
        element.tagName === 'INPUT' &&
        !validInputTypes.includes(element.type) &&
        element.type !== null
      ) {
        return {
          error: `Input element with ${targetDescription} has type "${element.type}" which is not fillable`,
          elementInfo,
        };
      }

      // Focus the element
      element.focus();

      // Type-specific handling for tricky inputs first
      if (
        element.tagName === 'INPUT' &&
        (element.type === 'checkbox' || element.type === 'radio')
      ) {
        // For radios, the selector/ref targets the specific option to select.
        const desired = element.type === 'radio' ? true : parseCheckedValue(value);
        if (typeof desired !== 'boolean') return { error: CHECKED_VALUE_ERROR, elementInfo };
        return await setToggle(element, desired, () => element.checked, elementInfo);
      }

      if (element.tagName === 'INPUT' && element.type === 'range') {
        const numericValue = typeof value === 'number' ? value : Number(value);
        if (Number.isNaN(numericValue)) {
          return { error: 'Range input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        element.value = String(numericValue);
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Set range to ${element.value} (min: ${element.min}, max: ${element.max})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'number') {
        if (value !== '' && value !== null && value !== undefined && Number.isNaN(Number(value))) {
          return { error: 'Number input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        element.value = String(value ?? '');
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Set number input to ${element.value} (previous: ${previous})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      // Fill the element based on its type
      if (element.tagName === 'SELECT') {
        // For select elements, find the option with matching value or text
        let optionFound = false;
        for (const option of element.options) {
          if (option.value === value || option.text === value) {
            element.value = option.value;
            optionFound = true;
            break;
          }
        }

        if (!optionFound) {
          return {
            error: `No option with value or text "${value}" found in select element`,
            elementInfo,
          };
        }

        // Trigger change event
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // For input and textarea elements
        // Clear the current value then set new value
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));

        element.value = String(value);

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Blur the element
      element.blur();

      return {
        success: true,
        message: 'Element filled successfully',
        elementInfo: {
          ...elementInfo,
          value: element.value, // Include the final value in the response
        },
      };
    } catch (error) {
      return {
        error: `Error filling element: ${error.message}`,
      };
    }
  }

  const CHECKED_VALUE_ERROR =
    'Checkbox requires a boolean (true/false) or a boolean-like string ("true"/"false"/"on"/"off").';

  function parseCheckedValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return undefined;
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return undefined;
  }

  /**
   * Toggle through the element's own activation (a real click event) so that framework
   * state (React value tracking, Vue v-model, aria widgets) follows. Writing `.checked`
   * only changes the DOM and a controlled component restores it on the next render.
   */
  async function setToggle(element, desired, read, elementInfo) {
    const previous = read();
    if (previous !== desired) element.click();
    for (let waited = 0; read() !== desired && waited < 500; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const checked = read();
    if (checked !== desired) {
      return {
        error: `Toggle stayed ${checked} after clicking; the page rejected the change to ${desired}`,
        elementInfo: { ...elementInfo, checked, previousChecked: previous },
      };
    }
    return {
      success: true,
      message:
        previous === desired ? `Already ${desired ? 'checked' : 'unchecked'}` : `Set to ${checked}`,
      elementInfo: { ...elementInfo, checked, previousChecked: previous },
    };
  }

  /**
   * Check if an element is visible
   * @param {Element} element - The element to check
   * @returns {boolean} - Whether the element is visible
   */
  function isElementVisible(element) {
    if (!element) return false;

    if (!isElementRendered(element)) return false;
    const rect = element.getBoundingClientRect();

    // Background/minimized tabs can report a zero viewport even though DOM
    // controls are fully rendered and safely fillable through native setters.
    // Pointer occlusion is irrelevant for fill operations in that state.
    if (
      document.visibilityState !== 'visible' ||
      window.innerWidth <= 0 ||
      window.innerHeight <= 0
    ) {
      return true;
    }

    // Check if element is within viewport
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    // Check if element is actually visible at its center point
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    if (!elementAtPoint) return false;

    return element === elementAtPoint || element.contains(elementAtPoint);
  }

  function isElementRendered(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'fillElement') {
      fillElement(request.selector, request.value, request.ref)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'chrome_fill_or_select_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
}
