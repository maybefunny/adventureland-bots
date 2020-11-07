import { BankPackType, ItemInfo, ServerIdentifier, ServerRegion } from "./definitions/adventureland.js"
import { Game } from "./Game.js"
import { Merchant } from "./Merchant.js"
import { PingCompensatedPlayer } from "./PingCompensatedPlayer.js"
import { Pathfinder } from "./Pathfinder.js"
import { Tools } from "./Tools.js"

const region: ServerRegion = "ASIA"
const identifier: ServerIdentifier = "I"

async function buyLoop(bot: PingCompensatedPlayer) {
    try {
        if (bot.socket.disconnected) return

        if (bot.hasItem("computer")) {
            // Buy HP Pots
            const numHpot1 = bot.countItem("hpot1")
            if (numHpot1 < 1000) await bot.buy("hpot1", 1000 - numHpot1)

            // Buy MP Pots
            const numMpot1 = bot.countItem("mpot1")
            if (numMpot1 < 1000) await bot.buy("mpot1", 1000 - numMpot1)
        }
    } catch (e) {
        console.error(e)
    }
    setTimeout(async () => { buyLoop(bot) }, 60000)
}

async function healLoop(bot: PingCompensatedPlayer) {
    try {
        if (bot.socket.disconnected) return

        const missingHP = bot.character.max_hp - bot.character.hp
        const missingMP = bot.character.max_mp - bot.character.mp
        const hpRatio = bot.character.hp / bot.character.max_hp
        const mpRatio = bot.character.mp / bot.character.max_mp
        const hpot1 = bot.locateItem("hpot1")
        const mpot1 = bot.locateItem("mpot1")
        if (hpRatio < mpRatio) {
            if (missingHP >= 400 && hpot1) {
                await bot.useHPPot(hpot1)
            } else {
                await bot.regenHP()
            }
        } else if (mpRatio < hpRatio) {
            if (missingMP >= 500 && mpot1) {
                await bot.useMPPot(mpot1)
            } else {
                await bot.regenMP()
            }
        } else if (hpRatio < 1) {
            if (missingHP >= 400 && hpot1) {
                await bot.useHPPot(hpot1)
            } else {
                await bot.regenHP()
            }
        }
    } catch (e) {
        //console.error(e)
    }

    setTimeout(async () => { healLoop(bot) }, Math.max(bot.getCooldown("use_hp"), 10))
}

async function mluckLoop(bot: Merchant) {
    try {
        if (bot.socket.disconnected) return

        if (bot.canUse("mluck")) {
            for (const [, player] of bot.players) {
                if (Tools.distance(bot.character, player) > bot.G.skills.mluck.range) continue // Too far away to mluck
                if (player.npc) continue // It's an NPC, we can't mluck NPCs.

                if (!player.s.mluck) {
                    console.log(`mlucking ${player.id} (give)`)
                    await bot.mluck(player.id) // Give the mluck 
                } else if (!player.s.mluck.strong && player.s.mluck.f !== bot.character.id) {
                    console.log(`mlucking ${player.id} (steal)`)
                    await bot.mluck(player.id) // Steal the mluck
                } else if (!player.s.mluck.strong && player.s.mluck.ms < (bot.G.conditions.mluck.duration - 60000)) {
                    console.log(`mlucking ${player.id} (extend)`)
                    await bot.mluck(player.id) // Extend the mluck
                }
            }
        }
    } catch (e) {
        console.error(e)
    }

    setTimeout(async () => { mluckLoop(bot) }, 250)
}

async function moveLoop(bot: Merchant) {
    try {
        if (bot.socket.disconnected) return

        // If we are dead, respawn
        if (bot.character.rip) {
            await bot.respawn()
            setTimeout(async () => { moveLoop(bot) }, 1000)
            return
        }

        await bot.closeMerchantStand()
        await bot.smartMove("goldnpc")

        // Store information about everything in our bank to use it later to find upgradable stuff
        const bankItems: ItemInfo[] = []
        for (let i = 0; i <= 7; i++) {
            const bankPack = `items${i}` as Exclude<BankPackType, "gold">
            for (const item of bot.bank[bankPack]) {
                bankItems.push(item)
            }
        }
        const duplicates = bot.locateDuplicateItems(bankItems)
        console.log(bot.bank)
        console.log(duplicates)

    } catch (e) {
        console.error(e)
    }

    setTimeout(async () => { moveLoop(bot) }, 250)
}

async function run() {
    await Promise.all([Game.loginJSONFile("../credentials.json"), Pathfinder.prepare()])

    const bot = await Game.startMerchant("earthMer5", region, identifier)
    buyLoop(bot)
    healLoop(bot)
    mluckLoop(bot)
    moveLoop(bot)

    console.log(bot.character)

    // Game.disconnect()
}

run()