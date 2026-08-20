import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth"; 

const firebaseConfig = {
  apiKey: "AIzaSyAJsTONAqHGL4LnkH_Xyn-sRyUETh52Acc",
  authDomain: "budgetapp-44f5e.firebaseapp.com",
  projectId: "budgetapp-44f5e",
  storageBucket: "budgetapp-44f5e.firebasestorage.app",
  messagingSenderId: "338018470720",
  appId: "1:338018470720:web:69c39937aefd823230c8a5",
  measurementId: "G-99QZJ0Q9ZT"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();