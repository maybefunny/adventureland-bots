import pkg from "mongoose"
const { Schema } = pkg

const NPCSchema = new Schema({
    name: String,
    map: String,
    x: Number,
    y: Number,
    serverRegion: String,
    serverIdentifier: String,
    type: String,
    lastSeen: { type: Number, required: false }
})

NPCSchema.index({ serverRegion: 1, serverIdentifier: 1, type: 1 }, { unique: true })
NPCSchema.index({ lastSeen: 1 })

export default NPCSchema