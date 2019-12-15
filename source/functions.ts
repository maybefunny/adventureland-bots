import { ItemInfo, MonsterType, ItemName, IPosition, MapName, IEntity, IPositionReal, SkillName, BankPackType } from "./definitions/adventureland";
import { MyItemInfo, EmptyBankSlots, MonsterSpawnPosition } from "./definitions/bots";
import { Character } from "./character";

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isNPC(entity: IEntity) {
    return entity.npc ? true : false
}

export function isMonster(entity: IEntity) {
    return entity.type == "monster"
}

export function isPlayer(entity: IEntity) {
    return entity.type == "character" && !isNPC(entity)
}

export function calculateDamageRange(attacker: IEntity, defender: IEntity): [number, number] {
    let baseDamage: number = attacker.attack;
    if (!attacker.apiercing) attacker.apiercing = 0
    if (!attacker.apiercing) attacker.rpiercing = 0
    if (!attacker.damage_type && attacker.slots.mainhand) attacker.damage_type = G.items[attacker.slots.mainhand.name].damage

    if (attacker.damage_type == "physical") {
        // Armor
        baseDamage *= damage_multiplier(defender.armor - attacker.apiercing)
    } else if (attacker.damage_type == "magical") {
        // Resistance
        baseDamage *= damage_multiplier(defender.resistance - attacker.rpiercing)
    }

    return [baseDamage * 0.9, baseDamage * 1.1]
}

/** Returns true if we're walking towards an entity. Used for checking if we can attack higher level enemies while we're moving somewhere */
// TODO: Finish this function, it's currently broken, don't use it.
export function areWalkingTowards(entity: IEntity) {
    if (!parent.character.moving) return false
    if (parent.character.vx < 0 && parent.character.real_x - entity.real_x > 0) return true
}

// TODO: Shouldn't this be a method on Character?
export function wantToAttack(c: Character, e: IEntity, s: SkillName = "attack"): boolean {
    if (parent.character.stoned) return false // We are stoned, we can't attack
    if (!isAvailable(s)) return false // On cooldown

    let range = G.skills[s].range ? G.skills[s].range : parent.character.range
    let distanceToEntity = distance(parent.character, e)
    if (G.skills[s].range_multiplier) range *= G.skills[s].range_multiplier
    if (distanceToEntity > range) return false // Too far away

    let mp = G.skills[s].mp ? G.skills[s].mp : parent.character.mp_cost
    if (parent.character.mp < mp) return false; // Insufficient MP

    if (!c.targetPriority[e.mtype]) return false // Not a priority
    if (e.target !== parent.character.id) {
        // Hold attack
        if (c.holdAttack) return false
        if (smart.moving && c.targetPriority[e.mtype].holdAttackWhileMoving) return false
        if (c.targetPriority[e.mtype].holdAttackInEntityRange && distanceToEntity <= e.range) return false

        // Low HP
        if (calculateDamageRange(e, parent.character)[1] * 5 / e.frequency > parent.character.hp && distanceToEntity <= e.range) return false
    }

    return true;
}

/** Also works for NPCs! */
export function canSeePlayer(name: string) {
    return parent.entities[name] ? true : false
}

/** Returns the amount of ms we have to wait to use this skill */
export function getCooldownMS(skill: SkillName) {
    if (parent.next_skill && parent.next_skill[skill]) {
        let ms = parent.next_skill[skill].getTime() - Date.now();
        return ms < parent.character.ping ? parent.character.ping : ms;
    } else {
        return parent.character.ping
    }
}

export function getExchangableItems(inventory?: ItemInfo[]): MyItemInfo[] {
    let items: MyItemInfo[] = []

    for (let item of getInventory(inventory)) {
        if (G.items[item.name].e) items.push(item)
    }

    return items;
}

export function getEmptySlots(store: ItemInfo[]): number[] {
    let slots: number[] = []
    for (let i = 0; i < store.length; i++) {
        if (!store[i]) slots.push(i)
    }
    return slots;
}

export function getEmptyBankSlots(): EmptyBankSlots[] {
    if (parent.character.map !== "bank") return; // We can only find out what bank slots we have if we're on the bank map.

    let emptySlots: EmptyBankSlots[] = []

    for (let store in parent.character.bank) {
        if (store == "gold") continue;
        for (let i = 0; i < 42; i++) {
            let item = parent.character.bank[store as BankPackType][i]
            if (!item) emptySlots.push({ pack: store as BankPackType, "index": i })
        }
    }

    return emptySlots;
}

export function isAvailable(skill: SkillName) {
    if (!parent.next_skill) return false
    if (parent.next_skill[skill] === undefined) return true
    if (["3shot", "5shot"].includes(skill)) return parent.next_skill["attack"] ? (Date.now() >= parent.next_skill["attack"].getTime()) : true

    return Date.now() >= parent.next_skill[skill].getTime()
}

/** Returns the entities we are being attacked by */
export function getAttackingEntities(): IEntity[] {
    let entitites: IEntity[] = []
    let isPVP = is_pvp();
    for (let id in parent.entities) {
        let entity = parent.entities[id]
        if (entity.target !== parent.character.id) continue; // Not being targeted by this entity
        if (isPlayer(entity) && !isPVP) continue; // Not PVP, ignore players

        entitites.push(entity)
    }
    return entitites;
}

export function sendMassCM(names: string[], data: any) {
    for (let name of names) {
        send_local_cm(name, data);
    }
}

export function getRandomMonsterSpawnPosition(type: MonsterType): MonsterSpawnPosition {
    let potentialLocations: IPositionReal[] = [];
    for (let id in G.maps) {
        let map = G.maps[id as MapName];
        if (map.instance) continue;
        for (let monster of map.monsters || []) {
            if (monster.type !== type) continue;
            if (monster.boundary) {
                potentialLocations.push({ "map": id as MapName, "x": (monster.boundary[0] + monster.boundary[2]) / 2, "y": (monster.boundary[1] + monster.boundary[3]) / 2 })
            } else if (monster.boundaries) {
                for (let boundary of monster.boundaries) {
                    potentialLocations.push({ "map": boundary[0], "x": (boundary[1] + boundary[3]) / 2, "y": (boundary[2] + boundary[4]) / 2 })
                }
            }
        }
    }

    return { ...potentialLocations[Math.floor(Math.random() * potentialLocations.length)], monster: type };
}

// TODO: Change this to a custom typed object instead of an array
export function getNearbyMonsterSpawns(position: IPosition, radius: number = 1000): MonsterSpawnPosition[] {
    let locations: MonsterSpawnPosition[] = [];
    let map = G.maps[position.map];
    if (map.instance) return;
    for (let monster of map.monsters || []) {
        if (monster.boundary) {
            let location = { "map": position.map as MapName, "x": (monster.boundary[0] + monster.boundary[2]) / 2, "y": (monster.boundary[1] + monster.boundary[3]) / 2 };
            if (distance(position, location) < radius) locations.push({ ...location, monster: monster.type })
        } else if (monster.boundaries) {
            for (let boundary of monster.boundaries) {
                if (boundary[0] !== position.map) continue;
                let location = { "map": position.map, "x": (boundary[1] + boundary[3]) / 2, "y": (boundary[2] + boundary[4]) / 2 }
                if (distance(position, location) < radius) locations.push({ ...location, monster: monster.type })
            }
        }
    }

    // Sort them so the closest one is first.
    locations.sort((a, b) => {
        return distance(position, a) > distance(position, b) ? 1 : -1
    })

    return locations;
}

export function buyIfNone(itemName: ItemName, targetLevel: number = 9, targetQuantity: number = 1) {
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
    if (!foundNPCBuyer) return; // Can't buy things, nobody is near.

    let items = findItemsWithLevel(itemName, targetLevel)
    if (items.length >= targetQuantity) return; // We have enough

    items = findItems(itemName);
    if (items.length < Math.min(2, targetQuantity)) buy_with_gold(itemName, 1); // Buy more if we don't have any to upgrade
}

/** Returns the inventory for the player, with all empty slots removed. */
export function getInventory(inventory = parent.character.items): MyItemInfo[] {
    let items: MyItemInfo[] = [];
    for (let i = 0; i < 42; i++) {
        if (!inventory[i]) continue; // No item in this slot
        items.push({ ...inventory[i], index: i })
    }
    return items;
}

export function findItem(name: ItemName): MyItemInfo {
    for (let i = 0; i < 42; i++) {
        if (!parent.character.items[i]) continue; // No item in this slot
        if (parent.character.items[i].name != name) continue; // Item doesn't match.

        return { ...parent.character.items[i], index: i }
    }
}

export function findItems(name: ItemName): MyItemInfo[] {
    let items: MyItemInfo[] = [];
    for (let i = 0; i < 42; i++) {
        if (!parent.character.items[i]) continue; // No item in this slot
        if (parent.character.items[i].name != name) continue; // Item doesn't match.

        items.push({ ...parent.character.items[i], index: i });
    }
    return items;
}

export function findItemsWithLevel(name: ItemName, level: number): MyItemInfo[] {
    let items: MyItemInfo[] = [];
    for (let i = 0; i < 42; i++) {
        if (!parent.character.items[i]) continue; // No item in this slot
        if (parent.character.items[i].name != name) continue; // Item doesn't match.
        if (parent.character.items[i].level != level) continue; // Level doesn't match

        items.push({ ...parent.character.items[i], index: i });
    }
    return items;
}