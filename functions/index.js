const functions = require('firebase-functions')
const admin = require('firebase-admin')
admin.initializeApp(functions.config().firebase)
const db = admin.database()

/*
  These functions are equal, except that the latter function will not commit
  if current value is null (or undefined)
*/
const increment = cur => (cur !== 0 && !cur) ? 1 : cur+1
const incrementIfNotNull = cur => (cur || cur === 0) ? cur+1 : undefined

const httpUsername = "ratherycronjobquestionchangeusername"
const httpPassword = "hglkajfnbglkajhasikebgklasjdgnlaasdg"

exports.setInactive = functions.https.onRequest((req, res) => {
  const { username, password, room="main" } = req.query
  if(username !== httpUsername || password !== httpPassword)
    return res.sendStatus(401)

  const setInactive = db.ref("rooms/"+room+"/active").set(false)
  const op1VotesPromise = db.ref("rooms/"+room+"/op1votes").once("value").then(ss => ss.val())
  const op2VotesPromise = db.ref("rooms/"+room+"/op2votes").once("value").then(ss => ss.val())

  return Promise.all([op1VotesPromise, op2VotesPromise, setInactive])
    .then(([v1, v2]) => giveScore(v1, v2, room))
    .then(() => res.sendStatus(200))
    .catch(err => {
      console.error(err)
      res.sendStatus(500)
    })
})

const giveScore = (op1Votes, op2Votes, room="main") => {
  if(op1Votes === op2Votes)
    return console.log("Votes for room " + room + " was equal")

  const op = op1Votes > op2Votes ? "op1" : "op2"
  return db.ref("votes/"+room).once("value")
    .then(ss => {
      if(!ss.exists() || !ss.hasChildren()) return;
      const uidOpPairs = ss.val()
      const uids = Object.keys(uidOpPairs)
      const filteredUids = uids.filter(uid => uidOpPairs[uid] === op)
      const promises = filteredUids.map(giveScoreToUser)
      return Promise.all(promises)
    })
}

const giveScoreToUser = uid => {
  //Leaves room for expanding
  return db.ref("users/"+uid+"/score").transaction(increment)
}



exports.updateQuestions = functions.https.onRequest((req, res) => {
  const { username, password } = req.query
  if(username !== httpUsername || password !== httpPassword)
    return res.sendStatus(401)

  const room = req.query.room || "main"

  return db.ref("laddervotes/"+room)
    .orderByChild("votes").limitToLast(1)
    .once("value")
    .then(ss => ss.val())
    .then(val => val ? ladderQuestionFound(val) : useDefaultQuestion())
    .then(() => res.sendStatus(200))
    .catch(err => {
      console.error("Failed to update main questions: ", err)
      res.sendStatus(500)
    })
})

const ladderQuestionFound = (val, room = "main") => {
  const key = Object.keys(val)[0]

  return db.ref("ladders/"+room+"/"+key).once("value")
  .then(ss => ss.val())
  .then(question => question || db.ref("laddervotes/"+room+"/"+key).remove())
  .then(question => doQuestionUpdate({ question, ladderKey: key, room }))
  .catch(err => {
    console.log("Error during ladder question update: ", err)
    return useDefaultQuestion()
  })
}

const useDefaultQuestion = () => {
  const numPromise = db.ref("defaultNum")
    .once("value")
    .then(ss => ss.val())
    .catch(err => console.warn("Failed to get current default question num: ", err))

  const defaultsPromise = db.ref("defaults")
    .once("value")
    .then(ss => ss.val())
    .then(val => Object.keys(val).map(key => val[key])) //Object.values is not a function?

  return Promise.all([numPromise, defaultsPromise])
  .then(([num, defaults]) => {
    if(!defaults) return console.log("No default questions exists")
    num = ++num >= defaults.length ? 1 : num
    return doQuestionUpdate({ question: defaults[num], num })
  })
  .catch(err => console.log("Failed to use default question: ", err.message))
}

const doQuestionUpdate = ({ room = "main", question, ladderKey, num = -1 }) => {
  const data = {
    ["votes/"+room]: null,
    ["rooms/"+room+"/ops"]: question,
    ["rooms/"+room+"/op1votes"]: 0,
    ["rooms/"+room+"/op2votes"]: 0,
    ["rooms/"+room+"/timestamp"]: admin.database.ServerValue.TIMESTAMP,
    ["rooms/"+room+"/active"]: true,
  }

  ladderKey && (data["ladders/"+room+"/"+ladderKey] = null)
  ladderKey && (data["laddervotes/"+room+"/"+ladderKey] = null)
  ladderKey && (data["laddervoters/"+room+"/"+ladderKey] = null)
  num !== -1 && (data["defaultNum"] = num)

  return new Promise((resolve, reject) => {
    db.ref().update(data)
    .then( resolve )
    .catch(err => reject("Failed to do question update: " + err))
  })
}



exports.ladderVoteAdded = functions.database.ref("/laddervoters/{room}/{postKey}/{uid}").onWrite(event => {
  if(!event.data.val()) return console.log("Laddervote was deleted")
  const { room, postKey } = event.params
  return db.ref("ladders/"+room+"/"+"/"+postKey).once("value")
  .then(ss => ss.exists())
  .then(exists => exists
    ? db.ref("laddervotes/"+room+"/"+postKey).transaction(increment).catch(console.error)
    : Promise.reject("Ladder post does not exist"))
  .catch(err => console.log("Failed to add laddervote: ", err))
})


exports.voteAdded = functions.database.ref("/votes/{room}/{uid}").onWrite(event => {
  if(!event.data.val()) return console.log("Vote was deleted")
  const { room } = event.params
  const op = event.data.val()
  return db.ref("rooms/"+room+"/"+op+"votes").transaction(increment).catch(console.error)
})


exports.handleShopAction = functions.database.ref("/shopactions/{actionKey}").onWrite(event => {
    if(!event.data.val()) return console.log("Shop action was deleted")
    const action = event.data.val()
    const actionKey = event.params.actionKey
    return shopActions.handleAction(actionKey, action).catch(console.error)
  })

const shopActions = {
  handleAction: (key, { uid, index }) => new Promise((resolve, reject) => {
    if(!uid || !index) return reject("Invalid shop action, dropping task. (uid or index is null)")

    const invRef = db.ref("users/"+uid+"/inventory/"+index)

    invRef.once("value")
    .then(ss   => ss.exists() && Promise.reject("User already owns that item"))
    .then(()   => shopActions.getItem({ index }))
    .then(item => item.active ? item : Promise.reject("Item is inactive"))
    .then(item => shopActions.saveNewScore({ uid, item }))
    .then(item => shopActions.saveToInvent({invRef, item}))
    .then(item => !item.isAvatar ? item : shopActions.saveAvatar({ uid, item }))
    .then( resolve )
    .catch( reject )
  }),

  getItem: ({ index }) => new Promise( (resolve, reject) => {
    const ref = db.ref("shop/"+index);
    ref.once("value")
    .then(ss => ss.val() )
    .then(item => item ? resolve(item) : Promise.reject("Item does not exist") )
    .catch(err => reject("Failed to get item: " + err) );
  }),

  saveNewScore: ({ uid, item }) => new Promise((resolve, reject) => {
    let scoreWasNull = false

    const transaction = score => {
      scoreWasNull = !score
      if(!score) return 0;
      if(score < item.cost) return console.log("Insufficient funds")
      return  score - item.cost
    }

    const cb = (err, committed, ss) => {
      if(scoreWasNull){
        console.log("Score was null, which means user has insufficient funds")
        return reject("Score transaction failed: insufficient funds")
      }

      return (committed || committed === 0)
        ? resolve(item)
        : reject("Score transaction failed: nothing was committed")
    }

    db.ref("users/"+uid+"/score")
    .transaction(transaction, cb, false)
    .catch(err => reject("Score transaction failed: " + err))
  }),

  saveToInvent: ({ invRef, item }) => new Promise((resolve, reject) => {
    invRef.set(item)
    .then(() => resolve(item))
    .catch(err => reject("Failed to save item to inventory: " + err) );
  }),

  saveAvatar: ({ uid, item }) => new Promise( (resolve, reject) => {
    const ref = db.ref("users/"+uid+"/avatars/"+item.image)
    const avaRef = db.ref("users/"+uid+"/avatar")

    ref.set(item)
    .then(() => avaRef.set(item.image) )
    .then(() => resolve(item) )
    .catch(err => reject("Avatar operation failed: " + err))
  }),

}
