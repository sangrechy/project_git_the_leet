class Solution {
public:
    int bestClosingTime(string customers) {
        int n=0;
        int y=0;
        for (int i=0;i<customers.length();i++){
            if (customers[i]=='Y'){
                y++;
            }
            else{
                n++;
            }
        }
        int cn=0;
        int cy=0;
        int h=0;
        int p=customers.length();
        for (int i=0;i<customers.length()+1;i++){
            int x=cn+y;
            if (x<p){
                p=x;
                h=i;
            }

            if (customers[i]=='Y'){
                cy++;
                y--;
            }
            else{
                cn++;
                n--;
            }
        }
        return h;
    }
};