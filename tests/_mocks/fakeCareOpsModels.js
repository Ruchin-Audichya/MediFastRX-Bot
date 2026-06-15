"use strict";

// In-memory stand-ins for the CareOps mongoose models so the workflow engine
// and service can be tested without MongoDB. Each fake implements the small
// surface careOpsService uses: create, findById, findOne (+sort/exec),
// find (+sort/limit/lean), countDocuments, deleteMany, and instance .save().
//
// Installed via tests/_mocks/installShims.stubModule BEFORE careOpsService is
// required.

const { stubModule } = require("./installShims");

let ID = 0;
const nextId = () => `id_${++ID}`;

class FakeDoc {
  constructor(store, data) {
    Object.assign(this, data);
    if (!this._id) this._id = nextId();
    this._store = store;
  }
  async save() {
    // Already by-reference in the store; just resolve.
    return this;
  }
  toObject() {
    const { _store, ...rest } = this;
    return rest;
  }
}

const makeQuery = (rows) => {
  const q = {
    _rows: rows,
    sort() {
      return q;
    },
    limit(n) {
      q._rows = q._rows.slice(0, n);
      return q;
    },
    async lean() {
      return q._rows.map((r) => ({ ...r }));
    },
    async exec() {
      return q._rows[0] || null;
    },
    then(resolve, reject) {
      // Make the query awaitable (findById/findOne without .exec()).
      return Promise.resolve(q._rows[0] || null).then(resolve, reject);
    },
  };
  return q;
};

const createModel = (defaults = {}) => {
  const store = [];
  const matches = (row, filter = {}) =>
    Object.entries(filter).every(([key, cond]) => {
      const val = key.split(".").reduce((o, k) => (o == null ? o : o[k]), row);
      if (cond && typeof cond === "object" && "$in" in cond) return cond.$in.includes(val);
      return val === cond;
    });

  const Model = {
    _store: store,
    async create(data) {
      // Apply schema-style defaults the real mongoose model would supply, so
      // status/escalated-based queries behave like production.
      const doc = new FakeDoc(store, { ...defaults, ...data });
      store.push(doc);
      return doc;
    },
    findById(id) {
      const row = store.find((r) => String(r._id) === String(id)) || null;
      return makeQuery(row ? [row] : []);
    },
    findOne(filter = {}) {
      const rows = store.filter((r) => matches(r, filter));
      return makeQuery(rows);
    },
    find(filter = {}) {
      const rows = store.filter((r) => matches(r, filter));
      return makeQuery(rows);
    },
    async countDocuments(filter = {}) {
      return store.filter((r) => matches(r, filter)).length;
    },
    async deleteMany() {
      store.length = 0;
      return { deletedCount: 0 };
    },
  };
  return Model;
};

const installCareOpsModelMocks = () => {
  const models = {
    CareCase: createModel({ status: "open", escalated: false, priority: "medium" }),
    CareTask: createModel({ status: "open", priority: "medium" }),
    CareIncident: createModel({ status: "open", escalated: false, slaBreached: false, priority: "high" }),
    CareWorkflow: createModel({ status: "open" }),
    AgentAction: createModel({}),
  };
  stubModule("src/careops/models/CareCase.js", models.CareCase);
  stubModule("src/careops/models/CareTask.js", models.CareTask);
  stubModule("src/careops/models/CareIncident.js", models.CareIncident);
  stubModule("src/careops/models/CareWorkflow.js", models.CareWorkflow);
  stubModule("src/careops/models/AgentAction.js", models.AgentAction);
  // Keep ServiceNow in mock mode and prevent any network from the service.
  return models;
};

module.exports = { installCareOpsModelMocks };
