import RedisStreamHelper from "redis-stream-helper"
import crypto from "crypto"

const {
  listenForMessages,
  createStreamGroup,
  addListener,
  addStreamData,
  client,
} = RedisStreamHelper(process.env.REDIS_PORT, process.env.REDIS_HOST)

const log = (msg, x) => (console.log(msg, x), x)

await createStreamGroup("global:process:trigger")
await createStreamGroup("global:process:complete")
await createStreamGroup("process:trigger")
await createStreamGroup("execution:trigger")
await createStreamGroup("process:complete")
await createStreamGroup("execution:complete")

addListener("global:process:trigger")
addListener("process:trigger")
addListener("execution:trigger")

const getCurrentGraph = (process, step) => {
  return client.call(
    "GRAPH.QUERY",
    process,
    `MATCH (a:Atom{step: '${step}'}) RETURN a.name`
  )
}

const addAtomStream = async (graph, id, process, payload) => {
  if (graph.length > 2 && Array.isArray(graph[1][0])) {
    const atomName = graph[1][0][0]
    const atomPayload = {
      execution: id,
      process: process,
      payload: payload,
    }
    addStreamData("atom:" + atomName + ":trigger", atomPayload)
  } else {
    await client.lpush(process + ":" + id, "END: " + new Date().toISOString())
    addStreamData("execution:complete", {
      process: process,
      payload: payload,
      id: id,
    })
  }
}

const orchestrate = async (key, streamId, data) => {
  const [type, ..._] = key.split(":")
  log("Stream: ", [key, streamId, data])
  if (type === "global") {
    const steps = JSON.parse(data.steps)
    try {
      await client.call("GRAPH.DELETE", data.name)
    } catch (e) {}
    let i = 0
    await client.call(
      "GRAPH.QUERY",
      data.name,
      "CREATE (:Start)-[:EXECUTES]->" +
        steps
          .map(
            (s) =>
              `(:Atom {name: '${s}', id: '${crypto.randomUUID()}', step: '${++i}'})-[:EXECUTES]->`
          )
          .join("") +
        "(:Return)"
    )
  } else if (type === "process") {
    addStreamData("execution:trigger", {
      process: data.name,
      payload: data.payload,
    })
  } else if (type === "execution") {
    if (!data.id) {
      const executionId = crypto.randomUUID()
      await client.lpush(
        data.process + ":" + executionId,
        "START: " + new Date().toISOString()
      )
      const graph = await getCurrentGraph(data.process, 1)
      addAtomStream(graph, executionId, data.process, data.payload)
    } else {
      const execLen = await client.llen(data.process + ":" + data.id)
      const graph = await getCurrentGraph(data.process, execLen)
      await client.lpush(data.process + ":" + data.id, data.payload)
      addAtomStream(graph, data.id, data.process, data.payload)
    }
  }
}

const run = async () => {
  await listenForMessages(orchestrate)
  run()
}

run()
