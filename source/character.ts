import { Queue } from "prioqueue"
import { MonsterName, Entity, ALPosition, ItemName } from './definitions/adventureland';
import { Pathfinder } from './pathfinder';

export abstract class Character {
    /**
     * A list of monsters, ranked from highest priority to lowest priority.
     */
    protected abstract targetPriority: MonsterName[];
    protected abstract mainTarget: MonsterName;
    protected movementQueue: ALPosition[] = [];
    protected movementTarget: MonsterName = null;
    protected pathfinder: Pathfinder = new Pathfinder(7);

    protected mainLoop(loopEveryMs = 250) {
        loot();
        setTimeout(() => { this.mainLoop(loopEveryMs); }, loopEveryMs);
    };
    public run() {
        this.healLoop();
        this.attackLoop();
        this.moveLoop();
        this.mainLoop();
    }

    protected getTargets(numTargets: number = 1): Entity[] {
        let targets: Entity[] = [];
        let target = get_targeted_monster();
        if (target && numTargets == 1 && distance(character, target) < character.range) {
            targets.push(target);
            return targets;
        }

        let potentialTargets = new Queue<Entity>((x, y) => x.priority - y.priority);
        for (let id in parent.entities) {
            let potentialTarget = parent.entities[id];
            let d = distance(character, potentialTarget);
            if (!this.targetPriority.includes(potentialTarget.mtype)) continue; // Not a monster we care about
            if (potentialTarget.type != "monster") // Not a monster
                if (!is_pvp() && potentialTarget.type == "character") continue; // Not PVP

            // Set a priority based on the index of the entity 
            let priority = this.targetPriority.indexOf(potentialTarget.mtype);
            if (potentialTarget.type == "monster" && priority == -1) continue; // Not a priority

            // Increase priority if it's our "main target"
            if (potentialTarget.mtype == this.mainTarget) priority += 10;

            // Increase priority if it's a quest monster
            if (potentialTarget.mtype == this.getMonsterhuntTarget()) priority += 100;

            // Increase priority if the entity is targeting us
            if (potentialTarget.target == character.name) priority += 1000;

            // Adjust priority based on distance
            priority -= d;

            // Adjust priority based on remaining HP
            priority -= potentialTarget.hp

            potentialTargets.enqueue(priority, potentialTarget);
        }

        if (potentialTargets.size == 0) {
            // No potential targets
            return targets;
        }

        while (targets.length < numTargets && potentialTargets.size > 0) {
            targets.push(potentialTargets.dequeue().value)
        }
        // if (this.movementTarget == newTarget.mtype) {
        //     // We've reached the monster we want to reach, so let's stop moving.
        //     this.movementTarget = null;
        //     this.movementQueue = [];
        // }
        if (targets.length > 0)
            change_target(targets[0])
        return targets;
    }

    protected attackLoop(): void {
        let targets = this.getTargets(1);
        if (!targets || distance(targets[0], character) > character.range || character.mp < character.mp_cost) {
            // No target
            setTimeout(() => { this.attackLoop() }, Math.max(50, parent.next_skill["attack"] - Date.now()));
            return;
        }
        attack(targets[0]).then(() => {
            // Attack success!
            setTimeout(() => { this.attackLoop() }, Math.max(50, parent.next_skill["attack"] - Date.now()));
        }, () => {
            // Attack fail...
            setTimeout(() => { this.attackLoop() }, Math.max(50, parent.next_skill["attack"] - Date.now()));
        });
    }

    protected moveLoop(): void {
        if (!this.movementQueue || this.movementQueue.length == 0) {
            // No movements in the queue, do nothing.
            setTimeout(() => { this.moveLoop() }, 250); // TODO: move this 250 cooldown to a setting.
            return;
        } else if (character.moving) {
            // We're already moving, don't move somewhere new.
            setTimeout(() => { this.moveLoop() }, 250) // TODO: Instead of 250, base it on how long it will take to walk to where we are going. (x && y && going_x && going_y && speed)
            return;
        }

        let nextMovement = this.movementQueue[0];
        if (nextMovement.map == character.map && can_move_to(nextMovement.x, nextMovement.y)) {
            // We can move to the next place in the queue, so let's start moving there.
            move(nextMovement.x, nextMovement.y)
            setTimeout(() => { this.moveLoop() }, 250); // TODO: queue up next movement based on time it will take to walk there
        } else {
            // We can't move to the next place in the queue...
            // TODO: Pathfind to the next place in the queue
        }

    }

    protected healLoop(): void {
        let hpPots: ItemName[] = ["hpot0", "hpot1"] // TODO: Create a type for itemnames.
        let mpPots: ItemName[] = ["mpot0", "mpot1"]
        let useMpPot: ItemName = null;
        let useHpPot: ItemName = null;

        // TODO: find last potion in inventory
        for (let i = character.items.length - 1; i >= 0; i--) {
            let item = character.items[i];
            if (!item) continue;

            if (!useHpPot && hpPots.includes(item.name)) {
                // This is the HP Pot that will be used
                useHpPot = item.name
            } else if (!useMpPot && mpPots.includes(item.name)) {
                // This is the MP Pot that will be used
                useMpPot = item.name
            }

            if (useHpPot && useMpPot) {
                // We've found the last two pots we're using
                break;
            }
        }

        let hp_ratio = character.hp / character.max_hp
        let mp_ratio = character.mp / character.max_mp
        if (useHpPot == "hpot0" && (character.max_hp - character.hp >= 200 || character.hp < 50)) {
            use_skill("use_hp")
        } else if (useHpPot == "hpot1" && (character.max_hp - character.hp >= 400 || character.hp < 50)) {
            use_skill("use_hp")
        } else if (useMpPot == "mpot0" && (character.max_mp - character.mp >= 300 || character.mp < 50)) {
            use_skill("use_mp")
        } else if (useMpPot == "mpot1" && (character.max_mp - character.mp >= 500 || character.mp < 50)) {
            use_skill("use_mp")
        } else if (useHpPot == null && hp_ratio != 1 && hp_ratio <= mp_ratio) {
            // Even if we don't have a potion, use_hp will heal for 50 hp.
            use_skill("use_hp")
        } else if (useMpPot == null && mp_ratio != 1 && mp_ratio < hp_ratio) {
            // Even if we don't have a potion, use_mp will heal for 100 mp.
            use_skill("use_mp")
        }

        setTimeout(() => { this.healLoop() }, Math.max(250, parent.next_skill["use_hp"] - Date.now()))
    }

    protected avoidAggroMonsters(buffer = 50): void {
        let closestEntity: Entity = null;
        let closestDistance = 999999;
        for (let id in parent.entities) {
            let potentialTarget = parent.entities[id];
            if (potentialTarget.type != "monster") continue; // Not a monster
            if (potentialTarget.aggro == 0) continue; // Not an aggressive monster
            let d = distance(character, potentialTarget);
            if (d < closestDistance) {
                closestEntity = potentialTarget;
                closestDistance = d;
            }
        }

        if (closestDistance > buffer) return; // No close monsters

        let escapePosition: ALPosition;
        let angle = Math.atan2((closestEntity.y - character.y), (closestEntity.x - character.x));
        let move_distance = closestDistance - buffer
        let x = Math.cos(angle) * move_distance
        let y = Math.sin(angle) * move_distance
        escapePosition = { x: character.x + x, y: character.y + y };

        if (can_move_to(escapePosition.x, escapePosition.y)) {
            move(escapePosition.x, escapePosition.y)
        } else {
            // TODO: Pathfind there, and take the first movement.
        }
    }

    protected avoidAttackingMonsters(): void {
        let attackingMonsters: Entity[] = [];
        for (let id in parent.entities) {
            let potentialTarget = parent.entities[id];
            if (potentialTarget.target != character.name) continue; // Not targeting us

            attackingMonsters.push(potentialTarget);
        }

        // TODO: geometry to move away from closest monster attacking us
        let minDistance = 99999;
        let escapePosition: ALPosition;
        for (let target of attackingMonsters) {
            let d = distance(character, target);
            if (d > (target.range + target.speed)) continue; // We're still far enough away to not get attacked
            if (d > minDistance) continue; // There's another target that's closer

            let angle = Math.atan((target.y - character.y) / (target.x - character.x));
            let move_distance = d - (character.range - (0.25 * target.speed)) // TODO: Is this 0.25 smart?
            let x = Math.cos(angle) * move_distance
            let y = Math.sin(angle) * move_distance
            if (target.x - character.x >= 0) {
                escapePosition = { x: character.x + x, y: character.y + y };
            } else {
                escapePosition = { x: character.x - x, y: character.y - y };
            }
        }

        if (!escapePosition) return; // We're safe where we are right now

        if (can_move_to(escapePosition.x, escapePosition.y)) {
            move(escapePosition.x, escapePosition.y)
        } else {
            // TODO: Pathfind there, and take the first movement.
        }
    }

    public moveToMonsters(): void {
        if (character.moving) return; // Already moving
        let targets = this.getTargets(1);
        if (targets && distance(character, targets[0]) < character.range)
            return; // We have a target, and it's in range.

        if (can_move_to(targets[0].x, targets[0].y)) {
            // Move normally to target
            move(targets[0].x, targets[0].y);
        } else {
            try {
                // Pathfind to target
                game_log("pathfinding to target")
                let path = this.pathfinder.findNextMovement(character, targets[0]);
                move(path.x, path.y);
            } catch (error) {
                // Our custom pathfinding failed, use the game's smart move.
                game_log("smart moving to target")
                xmove(targets[0].x, targets[0].y);
            }
        }
    }

    public getMonsterhuntTarget(): MonsterName {
        if (character.s && character.s["monsterhunt"])
            return character.s["monsterhunt"].target;

        return null;
    }

    public isInParty(): boolean {
        return Boolean(character.party);
    }
}