import { ItemName } from "./definitions/adventureland";
import { findItems, findItemsWithLevel, findItem } from "./functions";
let defaultItemsToKeep: ItemName[] = ["tracker", // Tracker
    "mpot0", "mpot1", "hpot0", "hpot1", // Potions
    "jacko"] // Useful for avoiding monsters
let defaultItemsToSell: ItemName[] = ["hpamulet", "hpbelt", // HP stuff
    "vitring", "vitearring", // Vit stuff
    "slimestaff", "ringsj", "cclaw", "spear", "throwingstars", "gphelmet", "phelmet", "maceofthedead", // Common things
    "coat", "shoes", "pants", "gloves", "helmet", // Common clothing
    /*"coat1", "shoes1",*/ "pants1", /*"gloves1", "helmet1",*/ // Heavy set
    "wbreeches", "wcap" // Wanderer clothing
];

export function sellUnwantedItems(itemsToSell: ItemName[] = defaultItemsToSell) {
    let foundNPCBuyer = false;
    for (let npc of parent.npcs.filter(npc => G.npcs[npc.id].role == "merchant")) {
        if (distance(parent.character, {
            x: npc.position[0],
            y: npc.position[1]
        }) < 350) {
            foundNPCBuyer = true;
            break;
        }
    }
    if (!foundNPCBuyer) return; // Can't sell things, nobody is near.

    for (let itemName of itemsToSell) {
        for (let item of findItems(itemName)) {
            if (item.level > 1) continue; // There might be a reason we upgraded it?

            if (item.q) {
                sell(item.index, item.q);
            } else {
                sell(item.index, 1);
            }
        }
    }
}

export function openMerchantStand() {
    let stand = findItem("stand0")
    if (!stand) return; // No stand available.

    if (parent.character.slots.trade16 === undefined) // Checks if the stand is closed
        parent.open_merchant(stand.index)
}

export function closeMerchantStand() {
    if (parent.character.slots.trade16 === null) // Checks if the stand is open
        parent.close_merchant()
}

export function buyFromPonty(itemNames: ItemName[]) {
    let foundPonty = false;
    for (let npc of parent.npcs) {
        if (npc.id == "secondhands" && distance(parent.character, {
            x: npc.position[0],
            y: npc.position[1]
        }) < 350) {
            foundPonty = true;
            break;
        }
    }
    if (!foundPonty) return; // We're not near Ponty, so don't buy from him.

    // Set up the handler
    let items_bought = 0;
    parent.socket.once("secondhands", (data: any) => {
        for (let i = 0; i < data.length; i++) {
            if (itemNames.includes(data[i].name)) {
                parent.socket.emit("sbuy", { "rid": data[i].rid });
                items_bought++;
                if (items_bought >= 5) break; // Only buy a few items at a time to prevent maxing out server calls.
            }
        }
    })

    // Attempt to buy stuff
    parent.socket.emit("secondhands")
}

export function transferItemsToMerchant(merchantName: string, itemsToKeep: ItemName[] = defaultItemsToKeep) {
    let merchant = parent.entities[merchantName];
    if (!merchant) return; // No merchant nearby
    if (distance(parent.character, merchant) > 250) return; // Merchant is too far away to trade

    for (let i = 0; i < parent.character.items.length; i++) {
        let item = parent.character.items[i]
        if (!item) continue // Empty slot
        if (itemsToKeep.includes(item.name)) continue // We want to keep this

        if (item.q) {
            send_item(merchantName, i, item.q)
        } else {
            send_item(merchantName, i, 1)
        }
    }
}

export function transferGoldToMerchant(merchantName: string, minimumGold: number = 0) {
    if (parent.character.gold <= minimumGold) return; // Not enough gold
    let merchant = parent.entities[merchantName];
    if (!merchant) return; // No merchant nearby
    if (distance(parent.character, merchant) > 250) return; // Merchant is too far away to trade

    send_gold(merchantName, parent.character.gold - minimumGold);
}

// TODO: Add check for shells
export function exchangeItems(xynExchangeItems: ItemName[] = ["gem0", "gem1", "armorbox", "weaponbox", "candy0", "candy1", "candycane", "mistletoe", "ornament"]) {
    // Xyn (Most exchanges)
    let foundUpgrade = false;
    for (let npc of parent.npcs) {
        if (npc.id == "exchange" && distance(parent.character, {
            x: npc.position[0],
            y: npc.position[1]
        }) < 250) {
            foundUpgrade = true;
            break;
        }
    }
    if (foundUpgrade && !parent.character.q["exchange"]) {
        for (let itemName of xynExchangeItems) {
            let items = findItems(itemName)
            if (items.length > 0) {
                parent.socket.emit("exchange", {
                    item_num: items[0].index,
                    q: items[0].q
                });
                return;
            }
        }
    }

    // Pwincess
    foundUpgrade = false;
    for (let npc of parent.npcs) {
        if (npc.id == "pwincess" && distance(parent.character, {
            x: npc.position[0],
            y: npc.position[1]
        }) < 250) {
            foundUpgrade = true;
            break;
        }
    }
    if (foundUpgrade && !parent.character.q["exchange"]) {
        // TODO: Move this to a parameter
        // NOTE: We are only exchanging level 2 lost earrings, because we want agile quivers
        let items = findItemsWithLevel("lostearring", 2)
        if (items.length) {
            parent.socket.emit("exchange", {
                item_num: items[0].index,
                q: items[0].q
            });
            return;
        }
    }
}

export function buyPots(hpPotName: ItemName, hpPotQuantity: number, mpPotName: ItemName, mpPotQuantity: number) {

}