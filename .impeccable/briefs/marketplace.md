# Marketplace

Mode: Operate. Scope: the Marketplace desktop window and Inventory's sell flow.
Build path: code-led extension of the user-approved Aero desktop. No new world,
new raster artwork, or concept selection: the user specifically requests another
app and the same inventory bubbles.

Direction contract: Marketplace launches from the menu and dock as an independent
window. Listings reuse ItemBubble and existing tokens. A seller selects a stack,
quantity and independently optional unit/whole-lot prices. A buyer chooses a linked
player and buys individual quantities or the whole remaining lot for existing coins.
Server acknowledgement precedes public availability; purchase totals, delivery,
return, full-inventory waits, and loading/error/empty states are explicit. Forms
stack on narrow screens; both themes preserve focus, readable surfaces and reduced
motion. No fabricated inventory, balance, listing, seller or completion state.

Review evidence: isolated sample-data renders of the real React components;
marketplace-desktop.png (default desktop, Light), marketplace-mobile.png (390px,
Dark), marketplace-purchase-mobile.png and marketplace-sell-mobile.png under
.impeccable/review/. The review used isolated renders while Docker was unavailable; the stack was subsequently rebuilt/deployed locally and the real unauthenticated launcher/window plus disposable offline fulfillment were verified. Existing window
bounce and geometry transitions are user-pinned and outside this change.
