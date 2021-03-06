import * as React from 'react';
import useDetectMounted from './hooks/useDetectMounted';
import useTimeout from './hooks/useTimeout';
import StateComponent from './StateComponent';
import cache from './cache';
import { LoadsConfig, LoadFunction, LoadingState, OptimisticCallback, OptimisticOpts, Record } from './types';

const STATES: { [key: string]: LoadingState } = {
  IDLE: 'idle',
  PENDING: 'pending',
  TIMEOUT: 'timeout',
  RESOLVED: 'resolved',
  REJECTED: 'rejected'
};

function reducer(state: Record, action: { type: LoadingState; isCached?: boolean; response?: any; error?: any }) {
  switch (action.type) {
    case STATES.IDLE:
      return { state: STATES.IDLE };
    case STATES.PENDING:
      return { ...state, state: STATES.PENDING };
    case STATES.TIMEOUT:
      return { ...state, state: STATES.TIMEOUT };
    case STATES.RESOLVED:
      return { ...state, isCached: action.isCached, response: action.response, state: STATES.RESOLVED };
    case STATES.REJECTED:
      return { ...state, isCached: action.isCached, error: action.error, state: STATES.REJECTED };
    default:
      return state;
  }
}

export default function useLoads(
  fn: LoadFunction,
  {
    cacheProvider,
    context,
    delay = 300,
    enableBackgroundStates = false,
    defer = false,
    loadPolicy = 'cache-and-load',
    timeout = 0,
    update: updateFn
  }: LoadsConfig = {},
  inputs = []
) {
  const counter = React.useRef<number>(0);
  const hasMounted = useDetectMounted();
  const [record, dispatch] = React.useReducer(reducer, { state: STATES.IDLE });
  const [setDelayTimeout, clearDelayTimeout] = useTimeout(() => dispatch({ type: STATES.PENDING }));
  const [setTimeoutTimeout, clearTimeoutTimeout] = useTimeout(() => dispatch({ type: STATES.TIMEOUT }));

  function handleData(data: { response?: any; error?: any }, state: LoadingState, count: number) {
    if (hasMounted.current && count === counter.current) {
      // @ts-ignore
      clearDelayTimeout();
      // @ts-ignore
      clearTimeoutTimeout();
      dispatch({
        type: state,
        isCached: Boolean(context),
        error: state === STATES.REJECTED ? data.error : undefined,
        response: state === STATES.RESOLVED ? data.response : undefined
      });
      if (context) {
        const record = { error: data.error, response: data.response, state };
        cache.set(context, record, { cacheProvider });
      }
    }
  }

  function handleOptimisticData(
    {
      data,
      optsOrCallback,
      callback
    }: { data: any; optsOrCallback?: OptimisticOpts | OptimisticCallback; callback?: OptimisticCallback },
    state: LoadingState,
    count: number
  ) {
    let newData = data;
    let opts: OptimisticOpts = {};

    if (typeof optsOrCallback === 'object') {
      opts = optsOrCallback;
    }

    if (typeof data === 'function') {
      let cachedValue;
      if (record.response) {
        cachedValue = record.response;
      } else if (opts.context) {
        cachedValue = cache.get(opts.context, { cacheProvider }) || {};
      }
      newData = data(cachedValue);
    }

    const value = {
      error: state === STATES.REJECTED ? newData : undefined,
      response: state === STATES.RESOLVED ? newData : undefined
    };
    if (!opts.context || context === opts.context) {
      handleData(value, state, count);
    } else {
      if (cache) {
        cache.set(opts.context, { ...value, state }, { cacheProvider });
      }
    }

    let newCallback = typeof optsOrCallback === 'function' ? optsOrCallback : callback;
    newCallback && newCallback(newData);
  }

  function load(opts?: { fn?: LoadFunction }) {
    return async (..._args: any) => {
      const args = _args.filter((arg: any) => arg.constructor.name !== 'Class');

      counter.current = counter.current + 1;

      let cachedRecord;
      if (context && loadPolicy !== 'load-only') {
        cachedRecord = cache.get(context, { cacheProvider });
        if (cachedRecord) {
          dispatch({ type: cachedRecord.state, isCached: true, ...cachedRecord });
          if (loadPolicy === 'cache-first') return;
        }
      }

      if (delay > 0) {
        setDelayTimeout(delay);
      } else {
        dispatch({ type: STATES.PENDING });
      }
      if (timeout > 0) {
        setTimeoutTimeout(timeout);
      }

      try {
        const loadFn = opts && opts.fn ? opts.fn : fn;
        const response = await loadFn(...args, {
          setResponse: (
            data: any,
            optsOrCallback: OptimisticOpts | OptimisticCallback,
            callback?: OptimisticCallback
          ) => handleOptimisticData({ data, optsOrCallback, callback }, STATES.RESOLVED, counter.current),
          setError: (data: any, optsOrCallback: OptimisticOpts | OptimisticCallback, callback?: OptimisticCallback) =>
            handleOptimisticData({ data, optsOrCallback, callback }, STATES.REJECTED, counter.current)
        });
        handleData({ response }, STATES.RESOLVED, counter.current);
      } catch (err) {
        handleData({ error: err }, STATES.REJECTED, counter.current);
      }
    };
  }

  const update = React.useMemo(
    () => {
      if (!updateFn) return;
      if (Array.isArray(updateFn)) {
        return updateFn.map(fn => load({ fn }));
      }
      return load({ fn: updateFn });
    },
    [updateFn]
  );

  cache.onSet = (key, value) => {
    if (key === context && loadPolicy !== 'load-only') {
      dispatch({ type: value.state, isCached: true, ...value });
    }
  };

  React.useEffect(
    () => {
      if (defer) return;
      load()();
    },
    [defer, context, ...inputs]
  );

  const states = {
    isIdle: record.state === STATES.IDLE && Boolean(!record.isCached || enableBackgroundStates),
    isPending: record.state === STATES.PENDING && Boolean(!record.isCached || enableBackgroundStates),
    isTimeout: record.state === STATES.TIMEOUT && Boolean(!record.isCached || enableBackgroundStates),
    isResolved: record.state === STATES.RESOLVED || Boolean(record.isCached && record.response),
    isRejected: record.state === STATES.REJECTED || Boolean(record.isCached && record.error)
  };
  return React.useMemo(
    () => ({
      load: load(),
      update,

      response: record.response,
      error: record.error,
      state: record.state,

      ...states,
      Idle: StateComponent(states.isIdle),
      Pending: StateComponent(states.isPending),
      Timeout: StateComponent(states.isTimeout),
      Resolved: StateComponent(states.isResolved),
      Rejected: StateComponent(states.isRejected),

      isCached: Boolean(record.isCached)
    }),
    [load, record.response, record.error, record.state, record.isCached]
  );
}
