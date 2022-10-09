import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Routes,
  Route,
  useNavigate,
} from "react-router-dom";
import {
  useDispatch,
  useSelector,
} from "react-redux";

import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import AdbWebUsbBackend, { AdbWebUsbBackendWatcher } from "@yume-chan/adb-backend-webusb";
import { Adb } from "@yume-chan/adb";

import AdbWrapper from "./utils/AdbWrapper";

import About from "./features/about/About";
import App from "./App";
import Settings from "./features/settings/Settings";

import {
  checkBinaries,
  checked,
  connected,
  connecting,
  connectionFailed,
  contextReset,
  reset as resetDevice,
  selectChecked,
  setAdb as deviceSetAdb,
  setProductInfo,
  setTemperature,
  setClaimed,
} from "./features/device/deviceSlice";

import {
  selectChecked as selectCheckedMaster,
  selectIsMaster,
} from "./features/tabGovernor/tabGovernorSlice";

import { reset as resetPackages } from "./features/packages/packagesSlice";
import { reset as resetHealthchecks } from "./features/healthcheck/healthcheckSlice";

export default function AdbRouter() {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const isChecked = useSelector(selectChecked);

  const isMaster = useSelector(selectIsMaster);
  const checkedMasterState = useSelector(selectCheckedMaster);

  const [adb, setAdb] = useState(null);
  const [device, setDevice] = useState(null);
  const [intervalId, setIntervalId] = useState(null);

  const adbRef = useRef();
  const deviceRef = useRef();
  const devicePromiseRef = useRef();
  const intervalRef = useRef();
  const watcherRef = useRef();

  const connectToDevice = useCallback(async (device) => {
    if(device && !adb) {
      try {
        setDevice(device);

        const credentialStore = new AdbWebCredentialStore();
        const streams = await device.connect();
        const adbLocal = await Adb.authenticate(streams, credentialStore, undefined);
        const adbWrapper = new AdbWrapper(adbLocal);

        dispatch(setClaimed(true));

        /**
         * The temperature check has two functions:
         * 1. Obviously checking the temperature
         * 2. Setting the adb prop: sometimes adb is not connectible from the beginning
         *    and requests to it might fail. As soon as the temperature is successfully
         *    returned, we can be confident that ADB is ready for our requests.
         *
         * A failsafe is in place, if we checked a certain amount of times, we assume
         * connection went fine. Some vistas seem to not query the temperature correctly.
         */
        const maxCheck = 3;
        let currentCheck = 0;
        const checkTemp = async () => {
          const temp = await adbWrapper.getTemperature();
          if(((temp && temp > 0) || (++currentCheck >= maxCheck)) && !adbRef.current) {
            setAdb(adbWrapper);

            await adbWrapper.establishReverseSocket(1);

            const info = await adbWrapper.getProductInfo();
            dispatch(setProductInfo(info));

            dispatch(resetPackages());
            dispatch(resetHealthchecks());
            dispatch(connected());
            dispatch(deviceSetAdb(true));
            dispatch(checkBinaries(adbWrapper));
          }

          dispatch(setTemperature(temp || "??"));
        };

        const newIntervalId = setInterval(checkTemp, 3000);
        setIntervalId(newIntervalId);
        await checkTemp();
      } catch(e) {
        console.log("Failed connecting to device:", e);
        dispatch(connectionFailed());
      }
    } else {
      if(!device) {
        dispatch(resetPackages());
        dispatch(resetHealthchecks());
      }
    }
  }, [adb, dispatch]);

  /**
   * If an ADB interface could be found, attempt to connect, otherwise
   * redirect to rooting page.
   */
  const connectOrRedirect = useCallback(async (device) => {
    if (hasAdb(device)) {
      const backendDevice = new AdbWebUsbBackend(device);
      await connectToDevice(backendDevice);
      devicePromiseRef.current = null;
    } else {
      navigate("/root");
    }
  }, [connectToDevice, navigate]);

  /**
   * Auto connect to ADB device if all criteria are matched.
   *
   * Assumes the first matching device to be the device we want to
   * connect to.
   */
  const autoConnect = useCallback(async() => {
    const canAutoConnect = (!devicePromiseRef.current && checkedMasterState && isMaster);
    if(canAutoConnect) {
      const devices = await navigator.usb.getDevices();
      if(devices.length > 0) {
        connectOrRedirect(devices[0]);
      }
    }
  }, [connectOrRedirect, checkedMasterState, devicePromiseRef, isMaster]);

  /**
   * Check if USB device has ADB interface.
   */
  const hasAdb = (device) => {
    for(let i = 0; i < device.configurations.length; i += 1) {
      const configuration = device.configurations[i];
      const interfaces = configuration.interfaces;

      for(let j = 0; j < interfaces.length; j += 1) {
        const currentInterface = interfaces[j].alternate;
        if (currentInterface.interfaceClass === 0xFF) {
          return true;
        }
      }
    }

    return false;
  };

  /**
   * A general usb device is invoked and the selected device is then used
   * to creat an ADB Backend, if this does not work, then we know that the
   * device is not rooted yet and we can redirect the user accordingly.
   *
   * This has the benefit that the user paired the device once and we will
   * be able to automatically connect after successful root without any
   * more user interaction.
   */
  const handleDeviceConnect = useCallback(async() => {
    dispatch(connecting());

    try {
      const filters = [{ vendorId: 0x2ca3 }];
      devicePromiseRef.current = navigator.usb.requestDevice({ filters });
      const device = await devicePromiseRef.current;

      connectOrRedirect(device);
    } catch(e) {
      dispatch(connectionFailed());
    }
  }, [connectOrRedirect, devicePromiseRef, dispatch]);

  // Set watcher to monitor WebUSB devices popping up or going away
  useEffect(() => {
    if(window.navigator.usb) {
      if(watcherRef.current) {
        watcherRef.current.dispose();
      }

      watcherRef.current = new AdbWebUsbBackendWatcher(async (id) => {
        if(!id) {
          setAdb(null);
          dispatch(resetDevice());
          clearInterval(intervalRef.current);
          setIntervalId(null);
        } else {
          await autoConnect();
        }
      });
    }
  }, [autoConnect, dispatch, watcherRef]);

  // Automatically try to connect to device when application starts up
  useEffect(() => {
    if(!isChecked && !adb && window.navigator.usb) {
      dispatch(checked(true));
      autoConnect();
    }
  }, [adb, autoConnect, dispatch, isChecked]);

  // Clean up when switching context (onUnmount)
  useEffect(() => {
    dispatch(contextReset());

    return async() => {
      dispatch(contextReset());

      if(watcherRef.current) {
        watcherRef.current.dispose();
      }

      if(intervalRef.current) {
        clearInterval(intervalRef.current);
      }

      if(deviceRef.current) {
        try {
          await deviceRef.current._device.close();
        } catch(e) {
          console.log("Failed closing device:", e);
        }
      }

      setAdb(null);
      setDevice(null);
      setIntervalId(null);
    };
  }, [dispatch]);

  // Update references when they change
  useEffect(() => {
    adbRef.current = adb;
  }, [adb]);

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  useEffect(() => {
    intervalRef.current = intervalId;
  }, [intervalId]);

  return(
    <Routes>
      <Route
        element={<Settings />}
        path="/settings"
      />

      <Route
        element={<About />}
        path="/about"
      />

      <Route
        element={
          <App
            adb={adb}
            handleAdbConnectClick={handleDeviceConnect}
          />
        }
        path="/*"
      />
    </Routes>
  );
}
