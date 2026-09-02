class Cart extends HTMLElement {
  static instances = [];
  static basket = {};
  static cartItems = [];

  static LOCKED_TITLE = "custom embroidery";
  static EMBROIDERY_VARIANT_IDS = [
    42002574966857,
    42002574999625,
    42002575032393
  ];

  static WATCHER_INTERVAL = null;
  static RECONCILE_PROMISE = null;
  static REFRESH_TIMER = null;
  static HAS_EMBROIDERY_REQUIREMENTS = false;

  constructor() {
    super();
    this.abort_controllers = {};
    this.checkout_button = null;
    this.dynamic_checkout_buttons = null;
    this.note = null;
    this.cart_form = null;
    this.checkoutValidationRunning = false;
  }

  connectedCallback() {
    if (!Cart.instances.includes(this)) {
      Cart.instances.push(this);
    }

    this.checkout_button = this.querySelector(".cart--checkout-button");
    this.dynamic_checkout_buttons = this.querySelector(
      ".cart--additional-buttons"
    );
    this.note = this.querySelector(".cart--notes--textarea");
    this.cart_form = this.querySelector("form");

    this.toggleLoadingOnSubmit();
    this.bindCheckoutFormProtection();

    if (this.note) this.noteTypingListener();

    if (this.dynamic_checkout_buttons) {
      this.renderDynamicCheckoutButtons();
    }

    this.bindLockedItemProtection();
    this.validateEmbroideryOnLoad();
    this.startEmbroideryWatcher();
  }

  disconnectedCallback() {
    Cart.instances = Cart.instances.filter(
      (instance) => instance !== this
    );
  }

  getCartUrl(suffix = "") {
    return `${theme.urls.cart}${suffix}`;
  }

  normalise(value) {
    return String(value ?? "").trim();
  }

  normaliseLower(value) {
    return this.normalise(value).toLowerCase();
  }

  getItemVariantId(item) {
    return Number(item?.variant_id || item?.id || 0);
  }

  isEmbroideryVariantId(variantId) {
    return Cart.EMBROIDERY_VARIANT_IDS.includes(
      Number(variantId)
    );
  }

  isLockedEmbroideryTitle(title) {
    return (
      this.normaliseLower(title) ===
      Cart.LOCKED_TITLE
    );
  }

  isEmbroideryFeeItemData(item) {
    const props = item?.properties || {};
    const title =
      item?.product_title || item?.title || "";

    return (
      this.isEmbroideryVariantId(
        this.getItemVariantId(item)
      ) ||
      this.normaliseLower(
        props._locked_embroidery_charge
      ) === "true" ||
      this.isLockedEmbroideryTitle(title)
    );
  }

  getItemTitle(itemEl) {
    if (!itemEl) return "";

    return this.normalise(
      itemEl.getAttribute("data-product-title") ||
        itemEl.querySelector(".cart--item--title")
          ?.textContent ||
        itemEl.querySelector(".cart--item-title")
          ?.textContent ||
        ""
    );
  }

  getDomItemVariantId(itemEl) {
    if (!itemEl) return 0;

    return Number(
      itemEl.getAttribute("data-variant-id") ||
        itemEl.dataset?.variantId ||
        0
    );
  }

  isLockedEmbroideryItem(itemEl) {
    return (
      this.isEmbroideryVariantId(
        this.getDomItemVariantId(itemEl)
      ) ||
      this.isLockedEmbroideryTitle(
        this.getItemTitle(itemEl)
      )
    );
  }

  getProperty(item, names) {
    const props = item?.properties || {};

    for (const name of names) {
      if (
        Object.prototype.hasOwnProperty.call(
          props,
          name
        )
      ) {
        const value = this.normalise(
          props[name]
        );

        if (value) {
          return value;
        }
      }
    }

    return "";
  }

  itemHasPersonalization(item) {
    if (
      !item ||
      this.isEmbroideryFeeItemData(item)
    ) {
      return false;
    }

    const explicitlyRequired =
      this.normaliseLower(
        this.getProperty(item, [
          "_requires_embroidery_charge"
        ])
      );

    if (
      explicitlyRequired === "true" ||
      explicitlyRequired === "1"
    ) {
      return true;
    }

    const savedFeeVariant = Number(
      this.getProperty(item, [
        "_embroidery_variant_id",
        "personalize_it_variant_id"
      ])
    );

    if (
      this.isEmbroideryVariantId(
        savedFeeVariant
      )
    ) {
      return true;
    }

    const embroideryType =
      this.getProperty(item, [
        "Embroidery Type",
        "Embroidery",
        "embroidery_type"
      ]);

    const words = this.getProperty(item, [
      "WordsNumbers",
      "wordsnumbers",
      "Words/Numbers",
      "_embroidery_text",
      "embroidery_text"
    ]);

    const monogram = this.getProperty(item, [
      "Monogram",
      "monogram",
      "_monogram"
    ]);

    return Boolean(
      embroideryType && (words || monogram)
    );
  }

  getRequiredEmbroideryVariantId(item) {
    const savedFeeVariant = Number(
      this.getProperty(item, [
        "_embroidery_variant_id",
        "personalize_it_variant_id"
      ])
    );

    if (
      this.isEmbroideryVariantId(
        savedFeeVariant
      )
    ) {
      return savedFeeVariant;
    }

    const words = this.getProperty(item, [
      "WordsNumbers",
      "wordsnumbers",
      "Words/Numbers",
      "_embroidery_text",
      "embroidery_text"
    ]);

    if (words.length > 28) {
      return 42002575032393;
    }

    if (words.length > 18) {
      return 42002574999625;
    }

    return 42002574966857;
  }

  getParentPairToken(item) {
    return this.getProperty(item, [
      "_embroidery_pair_token"
    ]);
  }

  getFeePairToken(item) {
    return this.getProperty(item, [
      "_embroidery_charge_for"
    ]);
  }

  async getCart() {
    const response = await fetch(
      this.getCartUrl(".js"),
      {
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(
        `Cart fetch failed: ${response.status}`
      );
    }

    return await response.json();
  }

  buildEmbroideryPlan(items) {
    const personalisedItems = items.filter(
      (item) =>
        this.itemHasPersonalization(item)
    );

    const feeItems = items.filter((item) =>
      this.isEmbroideryFeeItemData(item)
    );

    Cart.HAS_EMBROIDERY_REQUIREMENTS =
      personalisedItems.length > 0;

    const removeKeys = new Set();
    const additions = [];
    const pairedParentTokens = new Set();

    personalisedItems.forEach(
      (parentItem) => {
        const pairToken =
          this.getParentPairToken(parentItem);

        if (!pairToken) {
          return;
        }

        pairedParentTokens.add(pairToken);

        const requiredVariantId =
          this.getRequiredEmbroideryVariantId(
            parentItem
          );

        const requiredQuantity = Math.max(
          1,
          Number(parentItem.quantity || 1)
        );

        const pairedFees = feeItems.filter(
          (feeItem) =>
            this.getFeePairToken(feeItem) ===
            pairToken
        );

        const exactMatch =
          pairedFees.length === 1 &&
          this.getItemVariantId(
            pairedFees[0]
          ) === requiredVariantId &&
          Number(
            pairedFees[0].quantity || 0
          ) === requiredQuantity;

        if (exactMatch) {
          return;
        }

        pairedFees.forEach((feeItem) => {
          if (feeItem.key) {
            removeKeys.add(feeItem.key);
          }
        });

        additions.push({
          id: requiredVariantId,
          quantity: requiredQuantity,
          properties: {
            _locked_embroidery_charge:
              "true",
            _embroidery_charge_for:
              pairToken,
            _embroidery_parent_variant_id:
              String(
                parentItem.variant_id ||
                  parentItem.id ||
                  ""
              )
          }
        });
      }
    );

    feeItems.forEach((feeItem) => {
      const feePairToken =
        this.getFeePairToken(feeItem);

      if (
        feePairToken &&
        !pairedParentTokens.has(
          feePairToken
        ) &&
        feeItem.key
      ) {
        removeKeys.add(feeItem.key);
      }
    });

    const legacyRequiredCounts =
      new Map();

    personalisedItems.forEach(
      (parentItem) => {
        if (
          this.getParentPairToken(
            parentItem
          )
        ) {
          return;
        }

        const variantId =
          this.getRequiredEmbroideryVariantId(
            parentItem
          );

        const quantity = Math.max(
          1,
          Number(parentItem.quantity || 1)
        );

        legacyRequiredCounts.set(
          variantId,
          (legacyRequiredCounts.get(
            variantId
          ) || 0) + quantity
        );
      }
    );

    const legacyExistingCounts =
      new Map();

    feeItems.forEach((feeItem) => {
      if (
        this.getFeePairToken(feeItem)
      ) {
        return;
      }

      const variantId =
        this.getItemVariantId(feeItem);

      if (
        !this.isEmbroideryVariantId(
          variantId
        )
      ) {
        return;
      }

      legacyExistingCounts.set(
        variantId,
        (legacyExistingCounts.get(
          variantId
        ) || 0) +
          Number(feeItem.quantity || 0)
      );
    });

    legacyRequiredCounts.forEach(
      (requiredQuantity, variantId) => {
        const existingQuantity =
          legacyExistingCounts.get(
            variantId
          ) || 0;

        const missingQuantity =
          requiredQuantity -
          existingQuantity;

        if (missingQuantity > 0) {
          additions.push({
            id: variantId,
            quantity: missingQuantity,
            properties: {
              _locked_embroidery_charge:
                "true",
              _legacy_embroidery_repair:
                "true"
            }
          });
        }
      }
    );

    return {
      hasRequirements:
        personalisedItems.length > 0,
      removeKeys: [...removeKeys],
      additions
    };
  }

  async removeCartLineByKey(lineKey) {
    const response = await fetch(
      theme.urls.cart_change + ".js",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          id: lineKey,
          quantity: 0
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to remove incorrect embroidery charge: ${response.status}`
      );
    }
  }

  async addEmbroideryItems(items) {
    if (!items.length) {
      return;
    }

    const response = await fetch(
      theme.urls.cart_add + ".js",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          items
        })
      }
    );

    if (!response.ok) {
      const errorText =
        await response.text();

      throw new Error(
        errorText ||
          "Failed to add embroidery charge"
      );
    }
  }

  async reconcileEmbroideryCharges() {
    const cart = await this.getCart();

    const initialPlan =
      this.buildEmbroideryPlan(
        cart.items || []
      );

    if (
      !initialPlan.removeKeys.length &&
      !initialPlan.additions.length
    ) {
      return {
        ok: true,
        repaired: false,
        hasRequirements:
          initialPlan.hasRequirements
      };
    }

    for (
      const lineKey of
      initialPlan.removeKeys
    ) {
      await this.removeCartLineByKey(
        lineKey
      );
    }

    await this.addEmbroideryItems(
      initialPlan.additions
    );

    const verifiedCart =
      await this.getCart();

    const verificationPlan =
      this.buildEmbroideryPlan(
        verifiedCart.items || []
      );

    const ok =
      verificationPlan.removeKeys
        .length === 0 &&
      verificationPlan.additions
        .length === 0;

    return {
      ok,
      repaired: true,
      hasRequirements:
        verificationPlan.hasRequirements
    };
  }

  async ensureEmbroideryPresent() {
    if (!Cart.RECONCILE_PROMISE) {
      Cart.RECONCILE_PROMISE =
        this.reconcileEmbroideryCharges()
          .catch((error) => {
            console.error(
              "Embroidery guard failed:",
              error
            );

            return {
              ok: false,
              repaired: false,
              hasRequirements:
                Cart.HAS_EMBROIDERY_REQUIREMENTS
            };
          })
          .finally(() => {
            Cart.RECONCILE_PROMISE =
              null;
          });
    }

    const result =
      await Cart.RECONCILE_PROMISE;

    if (
      result.repaired &&
      result.ok
    ) {
      await Cart.fetchTotals();
      this.scheduleCartHtmlRefresh();
    }

    return result.ok;
  }

  scheduleCartHtmlRefresh() {
    if (Cart.REFRESH_TIMER) {
      return;
    }

    Cart.REFRESH_TIMER =
      window.setTimeout(
        async () => {
          Cart.REFRESH_TIMER = null;

          try {
            await Cart.updateAllHtml(
              true
            );
          } catch (error) {
            console.error(
              "Cart refresh failed:",
              error
            );
          }
        },
        50
      );
  }

  startEmbroideryWatcher() {
    if (Cart.WATCHER_INTERVAL) {
      return;
    }

    Cart.WATCHER_INTERVAL =
      window.setInterval(
        async () => {
          const activeInstance =
            Cart.instances.find(
              (instance) =>
                instance.isConnected
            );

          if (
            !activeInstance ||
            activeInstance
              .checkoutValidationRunning
          ) {
            return;
          }

          const ok =
            await activeInstance
              .ensureEmbroideryPresent();

          activeInstance
            .toggleCheckoutAvailability(
              ok
            );
        },
        1500
      );
  }

  async validateEmbroideryOnLoad() {
    this.toggleCheckoutAvailability(false);

    const ok =
      await this.ensureEmbroideryPresent();

    this.toggleCheckoutAvailability(ok);

    return ok;
  }

  toggleCheckoutAvailability(ok) {
    if (this.checkout_button) {
      if (ok) {
        this.checkout_button
          .removeAttribute("disabled");

        this.checkout_button.style
          .pointerEvents = "";

        this.checkout_button.style.opacity =
          "";
      } else {
        this.checkout_button.setAttribute(
          "disabled",
          "disabled"
        );

        this.checkout_button.style
          .pointerEvents = "none";

        this.checkout_button.style.opacity =
          "0.5";
      }
    }

    if (
      this.dynamic_checkout_buttons
    ) {
      const showDynamicButtons =
        ok &&
        !Cart.HAS_EMBROIDERY_REQUIREMENTS;

      this.dynamic_checkout_buttons.style
        .display = showDynamicButtons
        ? ""
        : "none";

      this.dynamic_checkout_buttons
        .setAttribute(
          "data-disabled",
          String(!showDynamicButtons)
        );
    }
  }

  async handleCheckoutAttempt(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (
      this.checkoutValidationRunning
    ) {
      return false;
    }

    this.checkoutValidationRunning =
      true;

    this.toggleCheckoutAvailability(
      false
    );

    if (this.checkout_button) {
      this.checkout_button.setAttribute(
        "data-loading",
        "true"
      );
    }

    const ok =
      await this.ensureEmbroideryPresent();

    if (!ok) {
      this.checkoutValidationRunning =
        false;

      this.checkout_button
        ?.removeAttribute(
          "data-loading"
        );

      this.toggleCheckoutAvailability(
        false
      );

      alert(
        "We could not verify the Custom Embroidery charge. Please refresh the cart and try again."
      );

      return false;
    }

    window.location.assign("/checkout");

    return true;
  }

  toggleLoadingOnSubmit() {
    if (
      !this.checkout_button ||
      this.checkout_button.dataset
        .embroideryGuardBound ===
        "true"
    ) {
      return;
    }

    this.checkout_button.dataset
      .embroideryGuardBound = "true";

    this.checkout_button
      .addEventListener(
        "click",
        (event) => {
          this.handleCheckoutAttempt(
            event
          );
        }
      );
  }

  bindCheckoutFormProtection() {
    if (
      !this.cart_form ||
      this.cart_form.dataset
        .embroideryGuardBound ===
        "true"
    ) {
      return;
    }

    this.cart_form.dataset
      .embroideryGuardBound = "true";

    this.cart_form.addEventListener(
      "submit",
      (event) => {
        const submitter =
          event.submitter;

        const isCheckoutSubmit =
          submitter?.classList?.contains(
            "cart--checkout-button"
          ) ||
          submitter?.name ===
            "checkout";

        if (isCheckoutSubmit) {
          this.handleCheckoutAttempt(
            event
          );
        }
      }
    );
  }

  noteTypingListener() {
    if (
      !this.note ||
      this.note.dataset.cartNoteBound ===
        "true"
    ) {
      return;
    }

    this.note.dataset.cartNoteBound =
      "true";

    this.note.addEventListener(
      "input",
      () => {
        this.updateNote(
          this.note.value
        );

        Cart.instances
          .filter(
            (instance) =>
              instance !== this
          )
          .forEach((instance) => {
            if (instance.note) {
              instance.note.value =
                this.note.value;
            }
          });
      }
    );
  }

  async updateNote(value) {
    if (
      this.abort_controllers.note
    ) {
      this.abort_controllers.note.abort();
    }

    this.abort_controllers.note =
      new AbortController();

    try {
      await fetch(
        theme.urls.cart_update +
          ".js",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            note: value
          }),
          signal:
            this.abort_controllers.note
              .signal
        }
      );
    } catch (error) {
      if (
        error?.name !==
        "AbortError"
      ) {
        console.error(
          "Cart note update failed:",
          error
        );
      }
    }
  }

  renderDynamicCheckoutButtons() {
    let drawerButtons;
    let mobileButtons;

    if (
      window.location.pathname ===
      theme.urls.cart
    ) {
      drawerButtons =
        theme.drawer?.querySelector(
          ".cart--additional-buttons"
        );

      if (drawerButtons) {
        drawerButtons.remove();
      }

      if (
        theme.mqs?.current_window ===
        "small"
      ) {
        mobileButtons =
          theme.drawer?.querySelector(
            '[data-view="desktop"] .cart--additional-buttons'
          );

        if (mobileButtons) {
          mobileButtons.remove();
        }
      }
    }
  }

  toggleLoadingDisplay(enable, line) {
    if (!enable && line) {
      const input = this.querySelector(
        `.cart--item[data-line-num='${line}'] input`
      );

      if (input) {
        input.setAttribute(
          "data-loading",
          "true"
        );
      }
    }

    if (this.checkout_button) {
      if (enable) {
        this.checkout_button
          .removeAttribute("disabled");
      } else {
        this.checkout_button.setAttribute(
          "disabled",
          "disabled"
        );
      }
    }

    if (
      this.dynamic_checkout_buttons
    ) {
      this.dynamic_checkout_buttons
        .setAttribute(
          "data-disabled",
          String(!enable)
        );
    }
  }

  async tryToUpdateQuantity(
    line,
    quantity
  ) {
    this.toggleLoadingDisplay(
      false,
      line
    );

    try {
      const allowed =
        await this.updateQuantity(
          line,
          quantity
        );

      await Cart.updateAllHtml();

      await this.validateEmbroideryOnLoad();

      if (
        !allowed &&
        quantity !== 0
      ) {
        this.showQuantityError(
          line,
          "This item can't be modified."
        );
      }
    } catch (error) {
      console.error(
        "Cart quantity update failed:",
        error
      );

      this.toggleLoadingDisplay(true);
    }
  }

  showQuantityError(line, message) {
    const item = this.querySelector(
      `.cart--item[data-line-num='${line}']`
    );

    if (!item) {
      return;
    }

    let error =
      item.querySelector(
        ".cart--error"
      );

    if (!error) {
      error =
        document.createElement("div");

      error.className =
        "cart--error";

      item.appendChild(error);
    }

    error.textContent =
      message ||
      "This item can't be modified.";

    error.style.color = "red";
    error.style.marginTop = "8px";
    error.style.display = "block";
  }

  getItemByLine(line) {
    return this.querySelector(
      `.cart--item[data-line-num='${line}']`
    );
  }

  async updateQuantity(
    line,
    quantity
  ) {
    if (
      this.abort_controllers
        .line_num
    ) {
      this.abort_controllers
        .line_num.abort();
    }

    this.abort_controllers.line_num =
      new AbortController();

    const itemEl =
      this.getItemByLine(line);

    if (!itemEl) {
      throw new Error(
        "Line item not found"
      );
    }

    if (
      this.isLockedEmbroideryItem(
        itemEl
      )
    ) {
      this.toggleLoadingDisplay(true);

      this.showQuantityError(
        line,
        "Custom Embroidery charge can't be removed or changed."
      );

      return false;
    }

    const {
      management,
      policy,
      quantity: inventoryQty
    } = itemEl.dataset;

    let adjustedQuantity =
      quantity;

    const inventoryBlocked =
      adjustedQuantity >
        Number.parseInt(
          inventoryQty || "0",
          10
        ) &&
      management === "shopify" &&
      policy !== "continue";

    if (inventoryBlocked) {
      adjustedQuantity =
        Number.parseInt(
          inventoryQty || "0",
          10
        );
    }

    try {
      const response = await fetch(
        theme.urls.cart_change +
          ".js",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            line,
            quantity:
              adjustedQuantity
          }),
          signal:
            this.abort_controllers
              .line_num.signal
        }
      );

      if (!response.ok) {
        throw new Error(
          response.statusText
        );
      }

      await Cart.fetchTotals();

      return !inventoryBlocked;
    } catch (error) {
      if (
        error?.name ===
        "AbortError"
      ) {
        throw new Error("aborted");
      }

      throw error;
    }
  }

  static updateAllHtml(
    resetTransitions
  ) {
    return Promise.allSettled(
      Cart.instances
        .filter(
          (instance) =>
            instance.isConnected
        )
        .map((instance) =>
          instance.updateHtml(
            resetTransitions
          )
        )
    );
  }

  async updateHtml(
    resetTransitions
  ) {
    const response = await fetch(
      theme.urls.cart +
        "?view=ajax-" +
        this.dataset.view
    );

    if (!response.ok) {
      throw new Error(
        response.statusText
      );
    }

    const html =
      await response.text();

    const parsed =
      theme.utils.parseHtml(
        html,
        ".cart--form"
      );

    if (!parsed) {
      throw new Error(
        "Updated cart markup was not found"
      );
    }

    this.swapInNewContent(parsed);
    this.toggleLoadingDisplay(true);

    theme.transitions.reload(
      "cart-" + this.dataset.view
    );

    if (resetTransitions) {
      theme.transitions.reset(
        "cart-" + this.dataset.view
      );
    }

    this.checkout_button =
      this.querySelector(
        ".cart--checkout-button"
      );

    this.dynamic_checkout_buttons =
      this.querySelector(
        ".cart--additional-buttons"
      );

    this.note =
      this.querySelector(
        ".cart--notes--textarea"
      );

    this.cart_form =
      this.querySelector("form");

    this.toggleLoadingOnSubmit();
    this.bindCheckoutFormProtection();

    if (this.note) {
      this.noteTypingListener();
    }

    this.bindLockedItemProtection();

    const ok =
      await this.validateEmbroideryOnLoad();

    this.toggleCheckoutAvailability(ok);

    window.trigger(
      "theme:cart:updated",
      this
    );

    return true;
  }

  swapInNewContent(newContent) {
    const currentBody =
      this.querySelector(
        ".cart--body"
      );

    let newBody =
      newContent.querySelector(
        ".cart--body"
      );

    if (currentBody && newBody) {
      newBody = this.swapInImages(
        currentBody,
        newBody
      );

      currentBody.replaceWith(
        newBody
      );
    }

    const currentTotal =
      this.querySelector(
        ".cart--total--price"
      );

    const newTotal =
      newContent.querySelector(
        ".cart--total--price"
      );

    if (
      currentTotal &&
      newTotal
    ) {
      currentTotal.replaceWith(
        newTotal
      );
    }
  }

  swapInImages(
    currentBody,
    newBody
  ) {
    const newItems =
      newBody.querySelectorAll(
        ".cart--item"
      );

    newItems.forEach((item) => {
      const newImage =
        item.querySelector(
          ".cart--item--image"
        );

      const existingImage =
        currentBody?.querySelector(
          `[data-variant-id='${item.getAttribute(
            "data-variant-id"
          )}'] .cart--item--image`
        );

      if (
        existingImage &&
        newImage
      ) {
        newImage.replaceWith(
          existingImage
        );
      }
    });

    return newBody;
  }

  bindLockedItemProtection() {
    const items =
      this.querySelectorAll(
        ".cart--item"
      );

    items.forEach((item) => {
      if (
        !this.isLockedEmbroideryItem(
          item
        )
      ) {
        return;
      }

      item.setAttribute(
        "data-locked-item",
        "true"
      );

      const qtyInput =
        item.querySelector(
          'input[name="updates[]"], input[type="number"]'
        );

      const minusBtn =
        item.querySelector(
          "[data-quantity-minus], .quantity-minus, .minus"
        );

      const plusBtn =
        item.querySelector(
          "[data-quantity-plus], .quantity-plus, .plus"
        );

      const removeLink =
        item.querySelector(
          '.cart--remove, .remove, a[href*="/cart/change"], [data-remove-item]'
        );

      if (qtyInput) {
        qtyInput.value = 1;

        qtyInput.setAttribute(
          "readonly",
          "readonly"
        );

        qtyInput.setAttribute(
          "disabled",
          "disabled"
        );

        qtyInput.style.pointerEvents =
          "none";

        qtyInput.style.opacity =
          "0.6";
      }

      [minusBtn, plusBtn].forEach(
        (button) => {
          if (!button) {
            return;
          }

          button.setAttribute(
            "disabled",
            "disabled"
          );

          button.style.pointerEvents =
            "none";

          button.style.opacity =
            "0.5";

          button.setAttribute(
            "aria-disabled",
            "true"
          );
        }
      );

      if (removeLink) {
        removeLink.setAttribute(
          "disabled",
          "disabled"
        );

        removeLink.setAttribute(
          "aria-disabled",
          "true"
        );

        removeLink.style.pointerEvents =
          "none";

        removeLink.style.opacity =
          "0.5";

        removeLink.style.cursor =
          "not-allowed";
      }
    });
  }

  static async addItem(
    fetchConfig = {},
    productData
  ) {
    const response = await fetch(
      theme.urls.cart_add + ".js",
      fetchConfig
    );

    if (!response.ok) {
      throw new Error(
        response.statusText
      );
    }

    await Cart.fetchTotals();
    await Cart.updateAllHtml(true);

    window.trigger(
      "theme:cart:productAdded",
      productData
    );
  }

  static async fetchTotals(
    skipDomUpdate = false
  ) {
    const response = await fetch(
      theme.urls.cart + ".js",
      {
        headers: {
          Accept:
            "application/json"
        },
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(
        response.statusText
      );
    }

    const cart =
      await response.json();

    Cart.fillBasket(
      cart.items || []
    );

    Cart.cartItems =
      cart.items || [];

    const {
      total_price
    } = cart;

    const item_count = (cart.items || []).reduce(
      (count, item) => {
        if (Number(item?.product_id) === 7351943430217) return count;
        return count + Math.max(Number(item?.quantity) || 0, 0);
      },
      0
    );

    if (!skipDomUpdate) {
      Cart.updateTotals(
        item_count,
        theme.utils.formatMoney(
          total_price
        )
      );
    }
  }

  static fillBasket(items) {
    Cart.basket = {};

    items.forEach(
      ({ id, quantity }) => {
        Cart.basket[id] =
          quantity;
      }
    );
  }

  static updateTotals(
    count,
    priceHtml
  ) {
    const countEls =
      document.querySelectorAll(
        "[data-cart-count]"
      );

    const priceEls =
      document.querySelectorAll(
        "[data-cart-price]"
      );

    countEls.forEach(
      (element) => {
        element.setAttribute(
          "data-cart-count",
          count
        );
      }
    );

    document.querySelectorAll(
      ".header-cart-counter-os"
    ).forEach(
      (element) => {
        element.textContent =
          count;
      }
    );

    priceEls.forEach(
      (element) => {
        element.innerHTML =
          priceHtml;
      }
    );

    Cart.instances
      .filter(
        (instance) =>
          instance.isConnected
      )
      .forEach(
        (instance, index) => {
          instance.setAttribute(
            "data-has-items",
            count > 0
          );

          if (
            count === 0 &&
            instance.note
          ) {
            instance.note.value =
              "";

            if (index === 0) {
              instance.updateNote(
                ""
              );
            }
          }

          instance
            .bindLockedItemProtection();
        }
      );
  }
}

theme.cart = Cart;

theme.cart.fetchTotals(true);

if (
  !customElements.get("cart-root")
) {
  customElements.define(
    "cart-root",
    Cart
  );
}
