// import 'newrelic';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';

import axios from 'axios';
import session from 'cookie-session';
import express from 'express';
import jwt from 'jsonwebtoken';
import morgan from 'morgan';
import multer, { MulterError } from 'multer';
import mysql, { RowDataPacket } from 'mysql2/promise';
import qs from 'qs';
import Aigle from 'aigle';
import * as _ from 'lodash';

dotenv.config();

const debug = !!process.env.DEBUG;

interface Config extends RowDataPacket {
  name: string;
  url: string;
}

interface IsuResponse {
  id: number;
  jia_isu_uuid: string;
  name: string;
  character: string;
}

interface Isu extends IsuResponse, RowDataPacket {
  image: Buffer;
  jia_user_id: string;
  created_at: Date;
  updated_at: Date;
}

interface GetIsuListResponse {
  id: number;
  jia_isu_uuid: string;
  name: string;
  character: string;
  latest_isu_condition?: GetIsuConditionResponse;
}

enum ConditionType {
  isBroken = 1,
  isDirty = 2,
  isOverweight = 4,
}

interface IsuCondition extends RowDataPacket {
  id: number;
  jia_isu_uuid: string;
  timestamp: Date;
  is_sitting: number;
  condition: string;
  condition_type: number;
  condition_level: string;
  message: string;
  created_at: Date;
}

interface InitializeResponse {
  language: string;
}

interface GetMeResponse {
  jia_user_id: string;
}

interface GraphResponse {
  start_at: number;
  end_at: number;
  data?: GraphDataPoint;
  condition_timestamps: number[];
}

interface GraphDataPoint {
  score: number;
  percentage: ConditionsPercentage;
}

interface ConditionsPercentage {
  sitting: number;
  is_broken: number;
  is_dirty: number;
  is_overweight: number;
}

interface GraphDataPointWithInfo {
  jiaIsuUUID: string;
  startAt: Date;
  data: GraphDataPoint;
  conditionTimeStamps: number[];
}

interface GetIsuConditionResponse {
  jia_isu_uuid: string;
  isu_name: string;
  timestamp: number;
  is_sitting: boolean;
  condition: string;
  condition_level: string;
  message: string;
}

interface TrendResponse {
  character: string;
  info: TrendCondition[];
  warning: TrendCondition[];
  critical: TrendCondition[];
}

interface TrendCondition {
  isu_id: number;
  timestamp: number;
}

const sessionName = 'isucondition_nodejs';
const conditionLimit = 20;
const frontendContentsPath = '../public';
const jiaJWTSigningKeyPath = '../ec256-public.pem';
const defaultIconFilePath = '../NoImage.jpg';
let defaultJIAServiceUrl = 'http://localhost:5000';
const mysqlErrNumDuplicateEntry = 1062;
const conditionLevelInfo = 'info';
const conditionLevelWarning = 'warning';
const conditionLevelCritical = 'critical';
const scoreConditionLevelInfo = 3;
const scoreConditionLevelWarning = 2;
const scoreConditionLevelCritical = 1;

const defaultImage = readFileSync(defaultIconFilePath);

if (!('POST_ISUCONDITION_TARGET_BASE_URL' in process.env)) {
  console.error('missing: POST_ISUCONDITION_TARGET_BASE_URL');
  process.exit(1);
}
const postIsuConditionTargetBaseURL = process.env['POST_ISUCONDITION_TARGET_BASE_URL'];
const dbinfo: mysql.PoolOptions = {
  host: process.env['MYSQL_HOST'] ?? '127.0.0.1',
  port: parseInt(process.env['MYSQL_PORT'] ?? '3306', 10),
  user: process.env['MYSQL_USER'] ?? 'isucon',
  database: process.env['MYSQL_DBNAME'] ?? 'isucondition',
  password: process.env['MYSQL_PASS'] || 'isucon',
  connectionLimit: 50,
  timezone: '+09:00',
};
const pool = mysql.createPool(dbinfo);
const upload = multer();

const app = express();

app.use(morgan('combined'));
app.use('/assets', express.static(frontendContentsPath + '/assets'));
app.use(express.json());
app.use(
  session({
    secret: process.env['SESSION_KEY'] ?? 'isucondition',
    name: sessionName,
    maxAge: 60 * 60 * 24 * 1000 * 30,
  }),
);
app.set('cert', readFileSync(jiaJWTSigningKeyPath));
app.set('etag', false);

class ErrorWithStatus extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

const limit = 60 * 1000;
const cacheMap = new Map<string, { ts: number; check: boolean }>();

async function getUserIdFromSession(req: express.Request, db: mysql.Connection): Promise<string> {
  if (!req.session) {
    throw new ErrorWithStatus(500, 'failed to get session');
  }
  const jiaUserId = req.session['jia_user_id'];
  if (!jiaUserId) {
    console.warn(`no session`);
    throw new ErrorWithStatus(401, 'no session');
  }
  const cache = cacheMap.get(jiaUserId);
  if (cache && Date.now() - cache.ts <= limit) {
    if (!cache.check) {
      throw new ErrorWithStatus(401, 'not found: user');
    }
    return jiaUserId;
  }

  let cnt: number;
  try {
    [[{ cnt }]] = await db.query<(RowDataPacket & { cnt: number })[]>(
      'SELECT COUNT(*) AS `cnt` FROM `user` WHERE `jia_user_id` = ?',
      [jiaUserId],
    );
  } catch (err) {
    // console.warn(`db error: ${err}`);
    throw new ErrorWithStatus(500, `db error: ${err}`);
  }
  cacheMap.set(jiaUserId, { ts: Date.now(), check: cnt !== 0 });
  if (cnt === 0) {
    // console.warn(`not found: user ${jiaUserId}`);
    throw new ErrorWithStatus(401, 'not found: user');
  }
  return jiaUserId;
}

interface PostInitializeRequest {
  jia_service_url: string;
}

function isValidPostInitializeRequest(body: PostInitializeRequest): body is PostInitializeRequest {
  return typeof body === 'object' && typeof body.jia_service_url === 'string';
}

// POST /initialize
// サービスを初期化
app.post('/initialize', async (req: express.Request<Record<string, never>, unknown, PostInitializeRequest>, res) => {
  const request = req.body;
  if (!isValidPostInitializeRequest(request)) {
    return res.status(400).type('text').send('bad request body');
  }

  try {
    await new Promise((resolve, reject) => {
      const cmd = spawn('../sql/init.sh');
      cmd.stdout.pipe(process.stderr);
      cmd.stderr.pipe(process.stderr);
      cmd.on('exit', (code) => {
        resolve(code);
      });
      cmd.on('error', (err) => {
        reject(err);
      });
    });
  } catch (err) {
    console.error(`exec init.sh error: ${err}`);
    return res.status(500).send();
  }

  const db = await pool.getConnection();
  await db.query('INSERT IGNORE INTO `characters` (`character`) SELECT `character` FROM `isu`');
  db.release();

  defaultJIAServiceUrl = request.jia_service_url;
  const initializeResponse: InitializeResponse = { language: 'nodejs' };
  return res.status(200).json(initializeResponse);
});

// POST /api/auth
// サインアップ・サインイン
app.post('/api/auth', async (req, res) => {
  const db = await pool.getConnection();
  try {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, req.app.get('cert')) as jwt.JwtPayload;
    } catch (err) {
      return res.status(403).type('text').send('forbidden');
    }

    const jiaUserId = decoded['jia_user_id'];
    if (typeof jiaUserId !== 'string') {
      return res.status(400).type('text').send('invalid JWT payload');
    }

    await db.query('INSERT IGNORE INTO user (`jia_user_id`) VALUES (?)', [jiaUserId]);
    req.session = { jia_user_id: jiaUserId };

    return res.status(200).send();
  } catch (err) {
    console.error(`db error: ${err}`);
    return res.status(500).send();
  } finally {
    db.release();
  }
});

// POST /api/signout
// サインアウト
app.post('/api/signout', async (req, res) => {
  const db = await pool.getConnection();
  try {
    try {
      await getUserIdFromSession(req, db);
    } catch (err) {
      if (err instanceof ErrorWithStatus && err.status === 401) {
        return res.status(401).type('text').send('you are not signed in');
      }
      console.error(err);
      return res.status(500).send();
    }

    req.session = null;
    return res.status(200).send();
  } finally {
    db.release();
  }
});

// GET /api/user/me
// サインインしている自分自身の情報を取得
app.get('/api/user/me', async (req, res) => {
  const db = await pool.getConnection();
  try {
    let jiaUserId: string;
    try {
      jiaUserId = await getUserIdFromSession(req, db);
    } catch (err) {
      if (err instanceof ErrorWithStatus && err.status === 401) {
        return res.status(401).type('text').send('you are not signed in');
      }
      console.error(err);
      return res.status(500).send();
    }

    const getMeResponse: GetMeResponse = { jia_user_id: jiaUserId };
    return res.status(200).json(getMeResponse);
  } finally {
    db.release();
  }
});

// GET /api/isu
// ISUの一覧を取得
app.get('/api/isu', async (req, res) => {
  const db = await pool.getConnection();
  try {
    let jiaUserId: string;
    try {
      jiaUserId = await getUserIdFromSession(req, db);
    } catch (err) {
      if (err instanceof ErrorWithStatus && err.status === 401) {
        return res.status(401).type('text').send('you are not signed in');
      }
      console.error(err);
      return res.status(500).send();
    }

    await db.beginTransaction();

    const [isuList] = await db.query<Isu[]>('SELECT * FROM `isu` WHERE `jia_user_id` = ? ORDER BY `id` DESC', [
      jiaUserId,
    ]);
    const responseList: Array<GetIsuListResponse> = await Aigle.map(isuList, async (isu) => {
      let foundLastCondition = true;
      const [[lastCondition]] = await db.query<IsuCondition[]>(
        'SELECT * FROM `isu_condition` WHERE `jia_isu_uuid` = ? ORDER BY `timestamp` DESC LIMIT 1',
        [isu.jia_isu_uuid],
      );
      if (!lastCondition) {
        foundLastCondition = false;
      }
      let formattedCondition = undefined;
      if (foundLastCondition) {
        const conditionLevel = calculateConditionLevelByType(lastCondition.condition_type);
        formattedCondition = {
          jia_isu_uuid: lastCondition.jia_isu_uuid,
          isu_name: isu.name,
          timestamp: lastCondition.timestamp.getTime() / 1000,
          is_sitting: !!lastCondition.is_sitting,
          condition: lastCondition.condition,
          condition_level: conditionLevel,
          message: lastCondition.message,
        };
      }
      return {
        id: isu.id,
        jia_isu_uuid: isu.jia_isu_uuid,
        name: isu.name,
        character: isu.character,
        latest_isu_condition: formattedCondition,
      };
    });
    await db.commit();

    return res.status(200).json(responseList);
  } catch (err) {
    console.error(`db error: ${err}`);
    await db.rollback();
    return res.status(500).send();
  } finally {
    db.release();
  }
});

interface PostIsuRequest {
  jia_isu_uuid: string;
  isu_name: string;
}

// POST /api/isu
// ISUを登録
app.post('/api/isu', (req: express.Request<Record<string, never>, unknown, PostIsuRequest>, res) => {
  upload.single('image')(req, res, async (uploadErr) => {
    const db = await pool.getConnection();
    try {
      let jiaUserId: string;
      try {
        jiaUserId = await getUserIdFromSession(req, db);
      } catch (err) {
        if (err instanceof ErrorWithStatus && err.status === 401) {
          return res.status(401).type('text').send('you are not signed in');
        }
        console.error(err);
        return res.status(500).send();
      }

      const request = req.body;
      const jiaIsuUUID = request.jia_isu_uuid;
      const isuName = request.isu_name;
      if (uploadErr instanceof MulterError) {
        return res.send(400).send('bad format: icon');
      }

      const image = req.file ? req.file.buffer : null;

      await db.beginTransaction();
      let insertId: number;

      try {
        const [result] = await db.query<any>(
          'INSERT INTO `isu` (`jia_isu_uuid`, `name`, `image`, `jia_user_id`) VALUES (?, ?, ?, ?)',
          [jiaIsuUUID, isuName, image, jiaUserId],
        );
        insertId = result.insertId;
      } catch (err) {
        await db.rollback();
        if (err.errno === mysqlErrNumDuplicateEntry) {
          return res.status(409).type('text').send('duplicated: isu');
        } else {
          console.error(`db error: ${err}`);
          return res.status(500).send();
        }
      }

      const targetUrl = defaultJIAServiceUrl + '/api/activate';

      let isuFromJIA: { character: string };
      try {
        const response = await axios.post(
          targetUrl,
          {
            target_base_url: postIsuConditionTargetBaseURL,
            isu_uuid: jiaIsuUUID,
          },
          {
            validateStatus: (status) => status < 500,
          },
        );
        if (response.status !== 202) {
          console.error(`JIAService returned error: status code ${response.status}, message: ${response.data}`);
          await db.rollback();
          return res.status(response.status).type('text').send('JIAService returned error');
        }
        isuFromJIA = response.data;
      } catch (err) {
        console.error(`failed to request to JIAService: ${err}`);
        await db.rollback();
        return res.status(500).send();
      }

      await Promise.all([
        db.query('UPDATE `isu` SET `character` = ? WHERE  `jia_isu_uuid` = ?', [isuFromJIA.character, jiaIsuUUID]),
        db.query('INSERT IGNORE INTO `characters` (`character`) VALUES (?)', [isuFromJIA.character]),
      ]);
      await db.commit();

      const isuResponse: IsuResponse = {
        id: insertId,
        jia_isu_uuid: jiaIsuUUID,
        name: isuName,
        character: isuFromJIA.character,
      };
      return res.status(201).send(isuResponse);
    } catch (err) {
      console.error(`db error: ${err}`);
      await db.rollback();
      return res.status(500).send();
    } finally {
      db.release();
    }
  });
});

// GET /api/isu/:jia_isu_uuid
// ISUの情報を取得
app.get('/api/isu/:jia_isu_uuid', async (req: express.Request<{ jia_isu_uuid: string }>, res) => {
  const db = await pool.getConnection();
  try {
    let jiaUserId: string;
    try {
      jiaUserId = await getUserIdFromSession(req, db);
    } catch (err) {
      if (err instanceof ErrorWithStatus && err.status === 401) {
        return res.status(401).type('text').send('you are not signed in');
      }
      console.error(err);
      return res.status(500).send();
    }

    const jiaIsuUUID = req.params.jia_isu_uuid;
    const [[isu]] = await db.query<Isu[]>('SELECT * FROM `isu` WHERE `jia_user_id` = ? AND `jia_isu_uuid` = ?', [
      jiaUserId,
      jiaIsuUUID,
    ]);
    if (!isu) {
      return res.status(404).type('text').send('not found: isu');
    }
    const isuResponse: IsuResponse = {
      id: isu.id,
      jia_isu_uuid: isu.jia_isu_uuid,
      name: isu.name,
      character: isu.character,
    };
    return res.status(200).json(isuResponse);
  } catch (err) {
    console.error(`db error: ${err}`);
    return res.status(500).send();
  } finally {
    db.release();
  }
});

// GET /api/isu/:jia_isu_uuid/icon
// ISUのアイコンを取得
app.get('/api/isu/:jia_isu_uuid/icon', async (req: express.Request<{ jia_isu_uuid: string }>, res) => {
  const db = await pool.getConnection();
  try {
    let jiaUserId: string;
    try {
      jiaUserId = await getUserIdFromSession(req, db);
    } catch (err) {
      if (err instanceof ErrorWithStatus && err.status === 401) {
        return res.status(401).type('text').send('you are not signed in');
      }
      console.error(err);
      return res.status(500).send();
    }

    const jiaIsuUUID = req.params.jia_isu_uuid;
    const [[row]] = await db.query<(RowDataPacket & { image: Buffer })[]>(
      'SELECT `image` FROM `isu` WHERE `jia_user_id` = ? AND `jia_isu_uuid` = ? LIMIT 1',
      [jiaUserId, jiaIsuUUID],
    );
    if (!row) {
      return res.status(404).type('text').send('not found: isu');
    }
    return res.status(200).send(row.image ?? defaultImage);
  } catch (err) {
    console.error(`db error: ${err}`);
    return res.status(500).send();
  } finally {
    db.release();
  }
});

interface GetIsuGraphQuery extends qs.ParsedQs {
  datetime?: string;
}

// GET /api/isu/:jia_isu_uuid/graph
// ISUのコンディショングラフ描画のための情報を取得
app.get(
  '/api/isu/:jia_isu_uuid/graph',
  async (req: express.Request<{ jia_isu_uuid: string }, unknown, never, GetIsuGraphQuery>, res) => {
    const db = await pool.getConnection();
    try {
      let jiaUserId: string;
      try {
        jiaUserId = await getUserIdFromSession(req, db);
      } catch (err) {
        if (err instanceof ErrorWithStatus && err.status === 401) {
          return res.status(401).type('text').send('you are not signed in');
        }
        console.error(err);
        return res.status(500).send();
      }

      const jiaIsuUUID = req.params.jia_isu_uuid;
      const datetimeStr = req.query.datetime;
      if (!datetimeStr) {
        return res.status(400).type('text').send('missing: datetime');
      }
      const datetime = parseInt(datetimeStr, 10);
      if (isNaN(datetime)) {
        return res.status(400).type('text').send('bad format: datetime');
      }
      const date = new Date(datetime * 1000);
      date.setMinutes(0, 0, 0);

      await db.beginTransaction();

      const [[{ cnt }]] = await db.query<(RowDataPacket & { cnt: number })[]>(
        'SELECT COUNT(*) AS `cnt` FROM `isu` WHERE `jia_user_id` = ? AND `jia_isu_uuid` = ?',
        [jiaUserId, jiaIsuUUID],
      );
      if (cnt === 0) {
        await db.rollback();
        return res.status(404).type('text').send('not found: isu');
      }
      const [getIsuGraphResponse, e] = await generateIsuGraphResponse(db, jiaIsuUUID, date);
      if (e) {
        console.error(e);
        await db.rollback();
        return res.status(500).send();
      }

      await db.commit();

      return res.status(200).json(getIsuGraphResponse);
    } catch (err) {
      console.error(`db error: ${err}`);
      await db.rollback();
      return res.status(500).send();
    } finally {
      db.release();
    }
  },
);

async function generateIsuGraphResponse(
  db: mysql.Connection,
  jiaIsuUUID: string,
  graphDate: Date,
): Promise<[GraphResponse[], Error?]> {
  const dataPoints: GraphDataPointWithInfo[] = [];
  let conditionsInThisHour = [];
  let timestampsInThisHour = [];
  let startTimeInThisHour = new Date(0);

  const [rows] = await db.query<IsuCondition[]>(
    'SELECT * FROM `isu_condition` WHERE `jia_isu_uuid` = ? ORDER BY `timestamp` ASC',
    [jiaIsuUUID],
  );

  for (const condition of rows) {
    const truncatedConditionTime = new Date(condition.timestamp);
    truncatedConditionTime.setMinutes(0, 0, 0);
    if (truncatedConditionTime.getTime() !== startTimeInThisHour.getTime()) {
      if (conditionsInThisHour.length > 0) {
        const [data, err] = calculateGraphDataPoint(conditionsInThisHour);
        if (err) {
          return [[], err];
        }
        dataPoints.push({
          jiaIsuUUID,
          startAt: startTimeInThisHour,
          data,
          conditionTimeStamps: timestampsInThisHour,
        });
      }
      startTimeInThisHour = truncatedConditionTime;
      conditionsInThisHour = [];
      timestampsInThisHour = [];
    }
    conditionsInThisHour.push(condition);
    timestampsInThisHour.push(condition.timestamp.getTime() / 1000);
  }

  if (conditionsInThisHour.length > 0) {
    const [data, err] = calculateGraphDataPoint(conditionsInThisHour);
    if (err) {
      return [[], err];
    }
    dataPoints.push({
      jiaIsuUUID,
      startAt: startTimeInThisHour,
      data,
      conditionTimeStamps: timestampsInThisHour,
    });
  }

  const endTime = new Date(graphDate.getTime() + 24 * 3600 * 1000);
  let startIndex = dataPoints.length;
  let endNextIndex = dataPoints.length;
  dataPoints.forEach((graph, i) => {
    if (startIndex === dataPoints.length && graph.startAt >= graphDate) {
      startIndex = i;
    }
    if (endNextIndex === dataPoints.length && graph.startAt > endTime) {
      endNextIndex = i;
    }
  });

  const filteredDataPoints: GraphDataPointWithInfo[] = [];
  if (startIndex < endNextIndex) {
    filteredDataPoints.push(...dataPoints.slice(startIndex, endNextIndex));
  }

  const responseList: GraphResponse[] = [];
  let index = 0;
  let thisTime = graphDate;

  while (thisTime < endTime) {
    let data = undefined;
    const timestamps: number[] = [];

    if (index < filteredDataPoints.length) {
      const dataWithInfo = filteredDataPoints[index];
      if (dataWithInfo.startAt.getTime() === thisTime.getTime()) {
        data = dataWithInfo.data;
        timestamps.push(...dataWithInfo.conditionTimeStamps);
        index++;
      }
    }

    responseList.push({
      start_at: thisTime.getTime() / 1000,
      end_at: thisTime.getTime() / 1000 + 3600,
      data,
      condition_timestamps: timestamps,
    });

    thisTime = new Date(thisTime.getTime() + 3600 * 1000);
  }

  return [responseList, undefined];
}

// 複数のISUのコンディションからグラフの一つのデータ点を計算
function calculateGraphDataPoint(isuConditions: IsuCondition[]): [GraphDataPoint, Error?] {
  const conditionsCount: Record<string, number> = {
    is_broken: 0,
    is_dirty: 0,
    is_overweight: 0,
  };
  let rawScore = 0;
  let sittingCount = 0;
  isuConditions.forEach((condition) => {
    if (condition.is_sitting) {
      sittingCount++;
    }
    let warnCount = 0;
    const conditionType = condition.condition_type;
    if (conditionType & ConditionType.isDirty) {
      conditionsCount['is_dirty'] += 1;
      warnCount++;
    }
    if (conditionType & ConditionType.isOverweight) {
      conditionsCount['is_overweight'] += 1;
      warnCount++;
    }
    if (conditionType & ConditionType.isBroken) {
      conditionsCount['is_broken'] += 1;
      warnCount++;
    }


    switch (warnCount) {
      case 0:
        rawScore += scoreConditionLevelInfo;
        break;
      case 1: // fallthrough
      case 2:
        rawScore += scoreConditionLevelWarning;
        break;
      case 3:
        rawScore += scoreConditionLevelCritical;
        break;
      default:
        throw new Error('Unreachable code');
    }
  });

  const isuConditionLength = isuConditions.length;
  const score = Math.trunc((rawScore * 100) / 3 / isuConditionLength);
  const sittingPercentage = Math.trunc((sittingCount * 100) / isuConditionLength);
  const isBrokenPercentage = Math.trunc((conditionsCount['is_broken'] * 100) / isuConditionLength);
  const isOverweightPercentage = Math.trunc((conditionsCount['is_overweight'] * 100) / isuConditionLength);
  const isDirtyPercentage = Math.trunc((conditionsCount['is_dirty'] * 100) / isuConditionLength);

  const dataPoint: GraphDataPoint = {
    score,
    percentage: {
      sitting: sittingPercentage,
      is_broken: isBrokenPercentage,
      is_overweight: isOverweightPercentage,
      is_dirty: isDirtyPercentage,
    },
  };
  return [dataPoint, undefined];
}

interface GetIsuConditionsQuery extends qs.ParsedQs {
  start_time: string;
  end_time: string;
  condition_level: string;
}

// GET /api/condition/:jia_isu_uuid
// ISUのコンディションを取得
app.get(
  '/api/condition/:jia_isu_uuid',
  async (req: express.Request<{ jia_isu_uuid: string }, unknown, never, GetIsuConditionsQuery>, res) => {
    const db = await pool.getConnection();
    try {
      let jiaUserId: string;
      try {
        jiaUserId = await getUserIdFromSession(req, db);
      } catch (err) {
        if (err instanceof ErrorWithStatus && err.status === 401) {
          return res.status(401).type('text').send('you are not signed in');
        }
        console.error(err);
        return res.status(500).send();
      }

      const jiaIsuUUID = req.params.jia_isu_uuid;

      const endTimeInt = parseInt(req.query.end_time, 10);
      if (isNaN(endTimeInt)) {
        return res.status(400).type('text').send('bad format: end_time');
      }
      const endTime = new Date(endTimeInt * 1000);
      if (!req.query.condition_level) {
        return res.status(400).type('text').send('missing: condition_level');
      }
      const conditionLevels = req.query.condition_level.split(',');

      const startTimeStr = req.query.start_time;
      let startTime = new Date(0);
      if (startTimeStr) {
        const startTimeInt = parseInt(startTimeStr, 10);
        if (isNaN(startTimeInt)) {
          return res.status(400).type('text').send('bad format: start_time');
        }
        startTime = new Date(startTimeInt * 1000);
      }

      const [[row]] = await db.query<(RowDataPacket & { name: string })[]>(
        'SELECT name FROM `isu` WHERE `jia_isu_uuid` = ? AND `jia_user_id` = ?',
        [jiaIsuUUID, jiaUserId],
      );
      if (!row) {
        return res.status(404).type('text').send('not found: isu');
      }

      const conditionResponse: GetIsuConditionResponse[] = await getIsuConditions(
        db,
        jiaIsuUUID,
        endTime,
        conditionLevels,
        startTime,
        conditionLimit,
        row.name,
      );
      res.status(200).json(conditionResponse);
    } catch (err) {
      console.error(`db error: ${err}`);
      return res.status(500).send();
    } finally {
      db.release();
    }
  },
);

const conditionTypeMemo = new Map<string, number>();

function getConditionType(conditionLevel: string): number {
  if (conditionTypeMemo.has(conditionLevel)) {
    return conditionTypeMemo.get(conditionLevel)!;
  }
  const list = new Set(conditionLevel.split(','));
  let type = 0;
  if (list.has('is_broken=true')) {
    type |= ConditionType.isBroken;
  }
  if (list.has('is_dirty=true')) {
    type |= ConditionType.isDirty;
  }
  if (list.has('is_overweight=true')) {
    type |= ConditionType.isOverweight;
  }
  conditionTypeMemo.set(conditionLevel, type);
  return type;
}

// ISUのコンディションをDBから取得
// const typesMap = {
//   info: [0],
//   warning: [
//     ConditionType.isBroken,
//     ConditionType.isDirty,
//     ConditionType.isOverweight,
//     ConditionType.isBroken & ConditionType.isDirty,
//     ConditionType.isBroken & ConditionType.isOverweight,
//     ConditionType.isDirty & ConditionType.isOverweight,
//   ],
//   critical: [ConditionType.isBroken & ConditionType.isDirty & ConditionType.isOverweight],
// };

async function getIsuConditions(
  db: mysql.Connection,
  jiaIsuUUID: string,
  endTime: Date,
  conditionLevels: string[],
  startTime: Date,
  limit: number,
  isuName: string,
): Promise<GetIsuConditionResponse[]> {
  const [conditions] =
    startTime.getTime() === 0
      ? await db.query<IsuCondition[]>(
        'SELECT * FROM `isu_condition` WHERE `jia_isu_uuid` = ?' +
        '	AND `condition_level` IN (?)' +
        '	AND `timestamp` < ?' +
        '	ORDER BY `timestamp` DESC LIMIT ?',
        [jiaIsuUUID, conditionLevels, endTime, limit],
      )
      : await db.query<IsuCondition[]>(
        'SELECT * FROM `isu_condition` WHERE `jia_isu_uuid` = ?' +
        '	AND `condition_level` IN (?)' +
        '	AND `timestamp` < ?' +
        '	AND ? <= `timestamp`' +
        '	ORDER BY `timestamp` DESC LIMIT ?',
        [jiaIsuUUID, conditionLevels, endTime, startTime, limit],
      );

  return conditions.map((condition) => {
    const cLevel = calculateConditionLevelByType(condition.condition_type);
    return {
      jia_isu_uuid: condition.jia_isu_uuid,
      isu_name: isuName,
      timestamp: condition.timestamp.getTime() / 1000,
      is_sitting: !!condition.is_sitting,
      condition: condition.condition,
      condition_level: cLevel,
      message: condition.message,
    };
  });
}

// ISUのコンディションの文字列からコンディションレベルを計算
function calculateConditionLevelByType(conditionType: number): string {
  let conditionLevel: string;
  let warnCount = 0;
  if (conditionType & ConditionType.isDirty) {
    warnCount++;
  }
  if (conditionType & ConditionType.isOverweight) {
    warnCount++;
  }
  if (conditionType & ConditionType.isBroken) {
    warnCount++;
  }
  switch (warnCount) {
    case 0:
      conditionLevel = conditionLevelInfo;
      break;
    case 1: // fallthrough
    case 2:
      conditionLevel = conditionLevelWarning;
      break;
    case 3:
      conditionLevel = conditionLevelCritical;
      break;
    default:
      throw new Error('Unreachable code');
  }
  return conditionLevel;
}

// GET /api/trend
// ISUの性格毎の最新のコンディション情報
app.get('/api/trend', async (req, res) => {
  const db = await pool.getConnection();
  try {
    const [characterList] = await db.query<(RowDataPacket & { character: string })[]>(
      'SELECT `character` FROM `characters`',
    );
    const characterIds = characterList.map((character) => character.character);
    const [isuList] = await db.query<Isu[]>('SELECT * FROM `isu` WHERE `character` IN (?)', [characterIds]);
    const isuListMap = _.groupBy(isuList, 'character');
    const trendResponse = await Aigle.map(characterList, async (character) => {
      const isuList = isuListMap[character.character] ?? [];
      const characterInfoIsuConditions: TrendCondition[] = [];
      const characterWarningIsuConditions: TrendCondition[] = [];
      const characterCriticalIsuConditions: TrendCondition[] = [];
      await Aigle.forEach(isuList, async (isu) => {
        const [conditions] = await db.query<IsuCondition[]>(
          'SELECT * FROM `isu_condition` WHERE `jia_isu_uuid` = ? ORDER BY timestamp DESC LIMIT 1',
          [isu.jia_isu_uuid],
        );

        if (conditions.length > 0) {
          const isuLastCondition = conditions[0];
          const conditionLevel = calculateConditionLevelByType(isuLastCondition.condition_type);
          const trendCondition: TrendCondition = {
            isu_id: isu.id,
            timestamp: isuLastCondition.timestamp.getTime() / 1000,
          };
          switch (conditionLevel) {
            case 'info':
              characterInfoIsuConditions.push(trendCondition);
              break;
            case 'warning':
              characterWarningIsuConditions.push(trendCondition);
              break;
            case 'critical':
              characterCriticalIsuConditions.push(trendCondition);
              break;
          }
        }
      });
      characterInfoIsuConditions.sort((a, b) => b.timestamp - a.timestamp);
      characterWarningIsuConditions.sort((a, b) => b.timestamp - a.timestamp);
      characterCriticalIsuConditions.sort((a, b) => b.timestamp - a.timestamp);
      return {
        character: character.character,
        info: characterInfoIsuConditions,
        warning: characterWarningIsuConditions,
        critical: characterCriticalIsuConditions,
      };
    });
    return res.status(200).json(trendResponse);
  } catch (err) {
    console.error(`db error: ${err}`);
    return res.status(500).send();
  } finally {
    db.release();
  }
});

interface PostIsuConditionRequest {
  is_sitting: boolean;
  condition: string;
  message: string;
  timestamp: number;
}

function isValidPostIsuConditionRequest(body: PostIsuConditionRequest[]): body is PostIsuConditionRequest[] {
  return (
    Array.isArray(body) &&
    body.every((data) => {
      return (
        typeof data.is_sitting === 'boolean' &&
        typeof data.condition === 'string' &&
        typeof data.message === 'string' &&
        typeof data.timestamp === 'number'
      );
    })
  );
}

// POST /api/condition/:jia_isu_uuid
// ISUからのコンディションを受け取る
app.post(
  '/api/condition/:jia_isu_uuid',
  async (req: express.Request<{ jia_isu_uuid: string }, unknown, PostIsuConditionRequest[]>, res) => {
    const db = await pool.getConnection();
    try {
      const jiaIsuUUID = req.params.jia_isu_uuid;

      const request = req.body;
      if (!isValidPostIsuConditionRequest(request) || request.length === 0) {
        return res.status(400).type('text').send('bad request body');
      }
      for (const cond of request) {
        if (!isValidConditionFormat(cond.condition)) {
          return res.status(400).type('text').send('bad request body');
        }
      }

      await db.beginTransaction();

      const [items] = await db.query<(RowDataPacket & { id: number })[]>(
        'SELECT id FROM `isu` WHERE `jia_isu_uuid` = ? LIMIT 1',
        [jiaIsuUUID],
      );
      if (items.length === 0) {
        await db.rollback();
        return res.status(404).type('text').send('not found: isu');
      }

      const conditions = request.map((cond) => {
        const type = getConditionType(cond.condition);
        return [
          jiaIsuUUID,
          new Date(cond.timestamp * 1000),
          cond.is_sitting,
          cond.condition,
          type,
          calculateConditionLevelByType(type),
          cond.message,
        ];
      });
      await db.query(
        'INSERT INTO `isu_condition`' +
        '	(`jia_isu_uuid`, `timestamp`, `is_sitting`, `condition`, `condition_type`, `condition_level`, `message`)' +
        '	VALUES ?',
        [conditions],
      );
      await db.commit();

      return res.status(202).send();
    } catch (err) {
      console.error(`db error: ${err}`);
      await db.rollback();
      return res.status(500).send();
    } finally {
      db.release();
    }
  },
);

const validConditionMap = new Map();

// ISUのコンディションの文字列がcsv形式になっているか検証
function isValidConditionFormat(condition: string): boolean {
  if (validConditionMap.has(condition)) {
    return validConditionMap.get(condition)!;
  }
  const keys = ['is_dirty', 'is_overweight', 'is_broken'];
  const params = condition.split(',');
  const result =
    params.length === keys.length &&
    keys.every((key, index) => {
      const [keyValue, value] = params[index].split('=');
      return keyValue === key && (value === 'true' || value === 'false');
    });
  validConditionMap.set(condition, result);
  return result;
}

['/', '/isu/:jia_isu_uuid', '/isu/:jia_isu_uuid/condition', '/isu/:jia_isu_uuid/graph', '/register'].forEach(
  (frontendPath) => {
    app.get(frontendPath, (_req, res) => {
      res.sendFile(path.resolve('../public', 'index.html'));
    });
  },
);

const port = parseInt(process.env['SERVER_APP_PORT'] ?? '3000', 10);
app.listen(port, () => {
  Logger.info('server listening', { port });
});

export enum LogLevel {
  Debug = 20,
  Info = 30,
  Warn = 40,
  Error = 50,
}

export class Logger {
  private static readonly logLevel = debug ? LogLevel.Debug : Logger.error;
  static debug(message: string, ...data: any[]) {
    Logger.log(LogLevel.Debug, message, data);
  }

  static info(message: string, ...data: any[]) {
    Logger.log(LogLevel.Info, message, data);
  }

  static warn(message: string, ...data: any[]) {
    Logger.log(LogLevel.Warn, message, data);
  }

  static error(message: string, ...data: any[]) {
    Logger.log(LogLevel.Error, message, data);
  }

  private static log(level: LogLevel, message: string, args: any[]) {
    if (level < this.logLevel) {
      return;
    }
    console.log(
      JSON.stringify({
        level,
        message,
        args,
      }),
    );
  }
}
