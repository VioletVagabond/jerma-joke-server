require('dotenv').config()

const tmi = require('tmi.js')
const api = require('./api')
const db = require('./db')
const moment = require('moment')

// eslint-disable-next-line new-cap
const client = new tmi.client({
  identity: {
    username: process.env.BOT_USERNAME,
    password: process.env.OAUTH_TOKEN
  },
  channels: [
    process.env.CHANNEL_NAME
  ]
})

client.on('message', onMessageHandler)

client.connect()

// Global
const streamsCollectionRef = db.collection('streams')
let streamDocRef = null
let stream = null
let video = null
const messages = []

// Format stream data from twitch api
async function getStreamData () {
  try {
    const response = await api.get(`streams?user_login=${process.env.USER_LOGIN}`)
    const stream = response.data.data[0]

    if (!stream) return false

    return {
      id: stream.id,
      gameID: stream.game_id,
      startedAt: stream.started_at,
      thumbnailURL: stream.thumbnail_url,
      title: stream.title,
      type: stream.type,
      userID: stream.user_id,
      userName: stream.user_name
    }
  } catch (error) {
    console.error('Failed to get stream:', error.response.data.message)
  }
}

// Format video data from twitch api
async function getVideoData () {
  try {
    const response = await api.get(`videos?user_id=${process.env.USER_ID}`)
    const video = response.data.data[0]

    if (!video) return false

    return {
      id: video.id,
      userID: video.user_id,
      userName: video.user_name,
      title: video.title,
      createdAt: video.created_at,
      publishedAt: video.published_at,
      URL: video.url,
      thumbnailURL: video.thumbnail_url,
      type: video.type,
      duration: video.duration
    }
  } catch (error) {
    console.error('Failed to get VOD:', error.response.data.message)
  }
}

async function update () {
  try {
    stream = await getStreamData()
    video = await getVideoData()
  } catch (error) {
    console.error('Failed to update stream:', error)
  }

  if (stream && !streamDocRef) {
    try {
      console.log('Stream started, establishing database connection')
      messages.length = 0
      streamDocRef = await streamsCollectionRef.doc(stream.id)
      await streamDocRef.set({ ...stream, video }, { merge: true })
    } catch (error) {
      console.error('Error creating stream:', error)
    }
  } else if (stream && streamDocRef) {
    try {
      console.log('Analyzing messages')
      await analyzeData()
    } catch (error) {
      console.error('Failed to analyze stream:', error)
    }
  } else if (!stream && streamDocRef) {
    try {
      console.log('Stream over, final analysis')
      video = await getVideoData()
      await streamDocRef.set({ type: 'offline', video }, { merge: true })
      await analyzeData()
      messages.length = 0
      streamDocRef = null
    } catch (error) {
      console.error('Failed to update stream:', error)
    }
  } else {
    console.log('Stream has not started')
  }
}

async function onMessageHandler (target, context, message, self) {
  if (self) return console.log('No self response')

  if (!streamDocRef) return

  if (message.includes('+2')) {
    context.joke = true
    context.msg = message
    try {
      messages.push(context)
      await streamDocRef.collection('messages').doc(context.id).set(context)
    } catch (error) {
      console.error('Failed to save message:', error)
    }
  } else if (message.includes('-2')) {
    context.joke = false
    context.msg = message
    try {
      messages.push(context)
      await streamDocRef.collection('messages').doc(context.id).set(context)
    } catch (error) {
      console.error('Failed to save message:', error)
    }
  }
}

async function analyzeData () {
  // Calculate the total joke score so far
  const jokeScoreTotal = messages.reduce((sum, message) => {
    return message.joke ? sum + 2 : sum - 2
  }, 0)

  const jokeScoreMin = messages.reduce((sum, message) => {
    return message.joke ? sum : sum - 2
  }, 0)

  const jokeScoreMax = messages.reduce((sum, message) => {
    return message.joke ? sum + 2 : sum
  }, 0)

  let jokeScoreHigh = 0
  messages.reduce((sum, message) => {
    message.joke ? sum += 2 : sum -= 2
    if (sum > jokeScoreHigh) jokeScoreHigh = sum
    return sum
  }, 0)

  let jokeScoreLow = 0
  messages.reduce((sum, message) => {
    message.joke ? sum += 2 : sum -= 2
    if (sum < jokeScoreLow) jokeScoreLow = sum
    return sum
  }, 0)

  const streamStartedAt = moment(stream.startedAt)
  const streamUpTime = moment().diff(streamStartedAt, 'minutes')

  let jokeScore = 0
  const parsedMessages = messages.map(message => {
    const messagePostedAt = moment(+message['tmi-sent-ts'])
    const interval = messagePostedAt.diff(streamStartedAt, 'minutes')

    message.joke ? jokeScore += 2 : jokeScore -= 2

    return { jokeScore, interval }
  })

  // Combine all messages with the same interval into one data point
  let interval = -1
  const data = []
  for (let i = parsedMessages.length - 1; i >= 0; i--) {
    const message = parsedMessages[i]
    if (message.interval !== interval) {
      data.unshift(message)
      interval = message.interval
    }
  }

  try {
    await streamDocRef.set({ data, streamUpTime, jokeScoreTotal, jokeScoreMin, jokeScoreMax, jokeScoreHigh, jokeScoreLow }, { merge: true })
  } catch (error) {
    console.error('Failed to save condensed data:', error)
  }
}

async function offlineAnalysis (streamID) {
  const streamDocRef = await streamsCollectionRef.doc(`${streamID}`)
  const messagesCollectionRef = await streamDocRef.collection('messages')
  const messagesQueryRef = await messagesCollectionRef.orderBy('tmi-sent-ts')

  const streamSnapshot = await streamDocRef.get()
  const messagesSnapshot = await messagesQueryRef.get()

  const streamData = streamSnapshot.data()

  const streamStartedAt = moment(streamData.startedAt)

  const analyzedData = []
  let jokeSum = 0
  messagesSnapshot.forEach(message => {
    const messageData = message.data()
    const messagePostedAt = moment(+messageData['tmi-sent-ts'])
    const messageStreamTimestamp = messagePostedAt.diff(streamStartedAt, 'minutes')

    messageData.joke ? jokeSum += 2 : jokeSum -= 2

    analyzedData.push({
      jokeScore: jokeSum,
      interval: messageStreamTimestamp
    })
  })
  console.log(jokeSum)
  await streamDocRef.set({ analyzedData }, { merge: true })
}

update()
setInterval(update, 10000)
